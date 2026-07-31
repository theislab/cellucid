/**
 * @fileoverview One definition of the selection step controls.
 *
 * All four selection tools publish the same four controls while a selection is
 * in progress — Confirm, Undo, Redo, Cancel. Building them here once keeps
 * their accessible names, their keyboard-shortcut hint, and where focus goes
 * when they are removed identical across the tools instead of drifting apart in
 * four copies of the same markup.
 *
 * @module ui/modules/highlight/step-controls
 */

import { requireDomElement, requireMethods } from './exact-contract.js';

/** Every tool that owns a step-control block, in toolbelt order. */
export const STEP_CONTROL_TOOLS = Object.freeze([
  'annotation',
  'knn',
  'proximity',
  'lasso'
]);

export function stepControlsId(tool) {
  if (!STEP_CONTROL_TOOLS.includes(tool)) {
    throw new TypeError(`Unknown selection step-control tool: ${tool}.`);
  }
  return `${tool}-step-controls`;
}

/**
 * Move focus off controls that are about to disappear.
 *
 * Confirm and Cancel destroy the block that contains them. A keyboard user who
 * activated either one is otherwise dropped onto `<body>` and has to tab in
 * from the top of the document again, so focus lands on the toolbelt button for
 * the mode they are still in — the nearest thing that is still there. The
 * toolbelt is addressed through the same `data-mode` + `aria-pressed` contract
 * `requireModeButtons` enforces, not through a style class.
 *
 * @param {HTMLElement} parent Element the step controls were appended to.
 */
function restoreFocusToActiveMode(parent) {
  if (typeof parent.querySelector !== 'function') return;
  const anchor = parent.querySelector('[data-mode][aria-pressed="true"]');
  if (anchor === null || typeof anchor.focus !== 'function') return;
  anchor.focus();
}

/**
 * Remove a tool's step controls, keeping keyboard focus somewhere usable.
 *
 * Focus is only moved when the controls actually held it; a mouse user who
 * never focused them must not be handed a focus ring by a Confirm click.
 *
 * @param {Document} documentOwner
 * @param {string} tool
 * @param {HTMLElement} parent Element the step controls were appended to.
 */
export function removeStepControls(documentOwner, tool, parent) {
  const controls = documentOwner.getElementById(stepControlsId(tool));
  if (controls === null) return false;
  const focused = documentOwner.activeElement;
  const heldFocus =
    focused !== null
    && focused !== undefined
    && typeof controls.contains === 'function'
    && controls.contains(focused);
  controls.remove();
  if (heldFocus) restoreFocusToActiveMode(parent);
  return true;
}

/**
 * Build (or look up) one tool's step controls.
 *
 * @param {object} options
 * @param {Document} options.documentOwner
 * @param {string} options.tool
 * @param {HTMLElement} options.parent
 * @param {(target: any, event: string, listener: () => void) => void} options.listen
 * @param {{undo: () => void, redo: () => void, confirm: () => void, cancel: () => void}} options.handlers
 * @returns {{undoButton: any, redoButton: any, confirmButton: any}}
 */
export function getStepControls(options) {
  const { documentOwner, tool, parent, listen, handlers } = options;
  const controlsId = stepControlsId(tool);
  requireMethods(
    documentOwner,
    'Selection step-control document',
    ['createElement', 'getElementById']
  );
  requireDomElement(parent, 'Selection step-control parent', ['appendChild']);
  if (typeof listen !== 'function') {
    throw new TypeError('Selection step controls require a listen() binder.');
  }
  for (const name of ['undo', 'redo', 'confirm', 'cancel']) {
    if (typeof handlers[name] !== 'function') {
      throw new TypeError(
        `Selection step controls require a ${name} handler.`
      );
    }
  }

  let controls = documentOwner.getElementById(controlsId);
  const created = controls === null;
  if (created) {
    controls = documentOwner.createElement('div');
    controls.id = controlsId;
    controls.className = 'lasso-step-controls';
    // The glyph buttons carry no readable text, so their accessible name has to
    // come from aria-label; a title alone leaves a screen reader announcing the
    // arrow character. Cancel advertises Escape because that is now a real
    // binding and nothing else in the panel would reveal it.
    controls.innerHTML = `
        <button type="button" class="btn-small lasso-confirm" id="${tool}-confirm-btn" title="Save this selection to the active highlight page">Confirm</button>
        <button type="button" class="btn-small btn-undo" id="${tool}-undo-btn" aria-label="Undo last selection step" title="Undo last selection step">↩</button>
        <button type="button" class="btn-small btn-redo" id="${tool}-redo-btn" aria-label="Redo last selection step" title="Redo last selection step">↪</button>
        <button type="button" class="btn-small lasso-cancel" id="${tool}-cancel-btn" aria-keyshortcuts="Escape" title="Discard this selection (Esc)">Cancel</button>
      `;
    parent.appendChild(controls);
  }
  const undoButton = requireDomElement(
    documentOwner.getElementById(`${tool}-undo-btn`),
    'Selection undo button',
    ['addEventListener']
  );
  const redoButton = requireDomElement(
    documentOwner.getElementById(`${tool}-redo-btn`),
    'Selection redo button',
    ['addEventListener']
  );
  const confirmButton = requireDomElement(
    documentOwner.getElementById(`${tool}-confirm-btn`),
    'Selection confirm button',
    ['addEventListener']
  );
  const cancelButton = requireDomElement(
    documentOwner.getElementById(`${tool}-cancel-btn`),
    'Selection cancel button',
    ['addEventListener']
  );
  if (created) {
    listen(undoButton, 'click', handlers.undo);
    listen(redoButton, 'click', handlers.redo);
    listen(confirmButton, 'click', handlers.confirm);
    listen(cancelButton, 'click', handlers.cancel);
  }
  return { undoButton, redoButton, confirmButton };
}
