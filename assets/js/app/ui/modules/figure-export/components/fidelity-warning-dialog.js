/**
 * @fileoverview Export fidelity warning dialog.
 *
 * Blocks an export when it cannot exactly reproduce the current view.
 *
 * @module ui/modules/figure-export/components/fidelity-warning-dialog
 */

import { createElement } from '../../../../utils/dom-utils.js';
import { showFigureExportModal } from './modal.js';
import { onAbort, requireSignalOrNull } from '../../../../../utils/abort.js';

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
  requireSignalOrNull(signal, 'Figure export fidelity signal');
  warnings.forEach((warning, index) => {
    if (
      warning === null ||
      typeof warning !== 'object' ||
      Array.isArray(warning) ||
      Object.getPrototypeOf(warning) !== Object.prototype ||
      !['detail,title', 'detail,fix,title'].includes(Object.keys(warning).sort().join(',')) ||
      (warning.fix !== undefined && (
        warning.fix === null
        || typeof warning.fix.label !== 'string'
        || typeof warning.fix.controlId !== 'string'
      )) ||
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
    let stopListening = () => {};
    const settleBlocked = () => {
      if (settled) return;
      settled = true;
      stopListening();
      resolve(false);
    };

    const body = createElement('div', {}, [
      createElement('p', { className: 'field-help' }, [
        'Cellucid will not create an export that differs from the active view. Resolve the following first:'
      ])
    ]);

    const list = createElement('div', { className: 'control-block' });
    for (const warning of warnings) {
      list.appendChild(createElement('div', { className: 'figure-export-warning' }, [
        createElement('h3', { className: 'section-title' }, [warning.title]),
        createElement('p', { className: 'field-help' }, [warning.detail])
      ]));
    }
    body.appendChild(list);

    // A view blocked only by layers a switch turns off (edges, the vector
    // field) is unblocked in one step: the switches are turned off as a
    // person would (their change events) and the export goes on.
    const fixes = warnings.every(warning => warning.fix !== undefined) ? warnings.map(warning => warning.fix) : null;
    const actions = createElement('div', { className: 'figure-export-modal-actions' }, [
      createElement('button', { type: 'button', className: 'btn' }, ['Back']),
      ...(fixes === null ? [] : [createElement('button', { type: 'button', className: 'btn btn-primary' }, [
        `Turn off ${fixes.map(fix => fix.label).join(' and ')} and export`,
      ])]),
    ]);
    body.appendChild(actions);

    const { close } = showFigureExportModal({
      title: heading,
      content: body,
      onClose: settleBlocked
    });
    // Stopped (already, or while it is shown): the dialog closes, blocked.
    stopListening = onAbort(signal, close);
    if (settled) return;

    const [backBtn, fixBtn] = actions.querySelectorAll('button');
    fixBtn?.addEventListener('click', () => {
      for (const fix of fixes) {
        const control = document.getElementById(fix.controlId);
        if (control?.checked === true) {
          control.checked = false;
          control.dispatchEvent(new Event('input', { bubbles: true }));
          control.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      if (settled) return;
      settled = true;
      stopListening();
      resolve(true);
      close();
    });
    backBtn.addEventListener('click', () => {
      settleBlocked();
      close();
    });
  });
}
