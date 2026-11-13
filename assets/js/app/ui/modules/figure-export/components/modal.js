/**
 * @fileoverview The figure export's dialog (the fidelity warnings): an app
 * dialog (`ui/components/app-dialog.js`) built around the content it is given,
 * its title the header band and focus on its first button.
 *
 * @module ui/modules/figure-export/components/modal
 */

import { createElement } from '../../../../utils/dom-utils.js';
import { wireAppDialog } from '../../../components/app-dialog.js';
import { createDomId } from '../../../components/dom-id.js';

/** Whether a figure export dialog is open: one at a time. */
let active = false;

/**
 * @param {object} options
 * @param {string} options.title
 * @param {HTMLElement} options.content
 * @param {() => void} options.onClose - Runs once, however it closed.
 * @returns {{ close: () => void }}
 */
export function showFigureExportModal({ title, content, onClose }) {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new TypeError('Figure export modal title must be a non-empty string.');
  }
  if (!(content instanceof HTMLElement)) {
    throw new TypeError('Figure export modal content must be an HTMLElement.');
  }
  if (typeof onClose !== 'function') {
    throw new TypeError('Figure export modal onClose must be a function.');
  }
  if (active) {
    throw new Error('A figure export modal is already active.');
  }
  const firstButton = Array.from(content.querySelectorAll('button')).find(button => !button.disabled);
  if (firstButton === undefined) {
    throw new Error(
      'Figure export modal content must contain an enabled focusable button.'
    );
  }

  const heading = createElement('h2', {}, [title]);
  heading.id = createDomId('figure-export-modal-title');
  const dialog = createElement('dialog', { className: 'app-dialog figure-export-modal' }, [
    createElement('div', { className: 'app-dialog-header' }, [heading]),
    createElement('div', { className: 'figure-export-modal-content' }, [content]),
  ]);
  dialog.setAttribute('aria-labelledby', heading.id);
  const owner = wireAppDialog(dialog, {
    onClose: () => {
      active = false;
      dialog.remove();
      onClose();
    },
  });
  document.body.append(dialog);
  try {
    owner.open(null, { focus: firstButton });
  } catch (error) {
    dialog.remove();
    throw error;
  }
  // Closed while it opened (`wireAppDialog`): its onClose has run already.
  active = dialog.open;
  return { close: owner.close };
}
