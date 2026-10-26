/**
 * @fileoverview One definition of the selection step controls.
 *
 * All four selection tools publish the same four controls while a selection is
 * in progress — Confirm, Undo, Redo, Cancel. Building them here once keeps
 * their accessible names, their keyboard-shortcut hint, and where focus goes
 * when they are removed identical across the tools instead of drifting apart in
 * four copies of the same markup.
 *
 * The selection bar over the plot (`#select-bar` in index.html) shows the same
 * controls a second time, for a screen where the panel is out of sight. It is a
 * mirror, not a copy: it is drawn here, from the same state, every time the
 * panel's block is, and its buttons press the panel's (see mode-ui.js), so each
 * action still has exactly one handler.
 *
 * @module ui/modules/highlight/step-controls
 */

import {
  requireDomElement,
  requireMethods,
  requireSafeInteger,
} from './exact-contract.js';
import { selectBarNotice } from './mode-copy.js';
import { formatCount, formatCountOf } from '../../../../utils/format-units.js';
import { requireExactKeys } from '../../../../utils/exact-record.js';

/** Every tool that owns a step-control block, in toolbelt order. */
export const STEP_CONTROL_TOOLS = Object.freeze([
  'annotation',
  'knn',
  'proximity',
  'lasso'
]);

function stepControlsId(tool) {
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
 * The selection bar's mirror of the step controls, or null on a page that has
 * no selection bar. The panel is the canonical surface, so its absence never
 * stops a tool.
 *
 * @param {Document} documentOwner
 */
function selectBarMirror(documentOwner) {
  const steps = documentOwner.getElementById('select-bar-steps');
  if (steps === null) return null;
  const mirror = {
    steps,
    selection: documentOwner.getElementById('select-bar-selection'),
    undo: documentOwner.getElementById('select-bar-undo'),
    confirm: documentOwner.getElementById('select-bar-confirm'),
    notice: documentOwner.getElementById('select-bar-notice')
  };
  for (const [name, element] of Object.entries(mirror)) {
    requireDomElement(element, `Selection bar ${name}`);
  }
  return mirror;
}

/**
 * Show one gesture's outcome on the selection bar: the short form of the
 * panel's notice, or nothing.
 */
function publishSelectBarNotice(mirror, notice) {
  const text = selectBarNotice(notice);
  mirror.notice.textContent = text;
  mirror.notice.hidden = text === '';
}

/**
 * Say on the selection bar what a tap or drag will do now. The owner of the
 * panel's idle copy calls this beside it: mode-ui.js when the tool changes,
 * and the annotation tool when its precondition (a coloured field) changes.
 *
 * @param {Document} documentOwner
 * @param {string} hint
 */
export function publishSelectBarHint(documentOwner, hint) {
  if (typeof hint !== 'string' || hint.length === 0) {
    throw new TypeError('Selection bar hint must be a nonempty string.');
  }
  const element = documentOwner.getElementById('select-bar-hint');
  if (element === null) return;
  requireDomElement(element, 'Selection bar hint');
  element.textContent = hint;
}

/**
 * Say in the Selection (i) tip what the active tool's gesture is, or what it
 * needs first. The owner of the tool's idle copy calls this beside the
 * selection bar's hint: mode-ui.js when the tool changes, and each tool when
 * it shows nothing in progress.
 *
 * @param {Document} documentOwner
 * @param {string} hint
 */
export function publishToolHint(documentOwner, hint) {
  if (typeof hint !== 'string' || hint.length === 0) {
    throw new TypeError('Selection tool hint must be a nonempty string.');
  }
  const element = documentOwner.getElementById('highlight-tool-hint');
  if (element === null) return;
  requireDomElement(element, 'Selection tool hint');
  element.textContent = hint;
}

function cellCountText(count) {
  return `${formatCountOf(count, 'cell')} selected`;
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
 * @param {string} notice "" or the SELECTION_NOTICE the panel shows with them
 */
export function removeStepControls(documentOwner, tool, parent, notice) {
  const mirror = selectBarMirror(documentOwner);
  if (mirror !== null) {
    publishSelectBarNotice(mirror, notice);
    if (mirror.steps.dataset.tool === tool) {
      mirror.steps.hidden = true;
      mirror.steps.dataset.tool = '';
    }
  }
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
 * Build (or update) one tool's step controls, and their mirror on the
 * selection bar.
 *
 * @param {object} options
 * @param {Document} options.documentOwner
 * @param {string} options.tool
 * @param {HTMLElement} options.parent
 * @param {(target: any, event: string, listener: () => void) => void} options.listen
 * @param {{undo: () => void, redo: () => void, confirm: () => void, cancel: () => void}} options.handlers
 * @param {{candidateCount: number, canUndo: boolean, canRedo: boolean, notice: string}} options.readout
 *   what the selection holds now; Confirm is offered only for a nonempty one
 */
export function showStepControls(options) {
  const { documentOwner, tool, parent, listen, handlers, readout } = options;
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
  requireExactKeys(
    readout,
    ['candidateCount', 'canUndo', 'canRedo', 'notice'],
    'Selection step readout'
  );
  requireSafeInteger(readout.candidateCount, 'Selection step candidate count', 0);
  for (const name of ['canUndo', 'canRedo']) {
    if (typeof readout[name] !== 'boolean') {
      throw new TypeError(`Selection step ${name} must be a boolean.`);
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
        <button type="button" class="btn btn-compact btn-primary lasso-confirm" id="${tool}-confirm-btn" title="Save this selection to the active highlight page">Confirm</button>
        <button type="button" class="btn btn-compact btn-undo" id="${tool}-undo-btn" aria-label="Undo last selection step" title="Undo last selection step">↩</button>
        <button type="button" class="btn btn-compact btn-redo" id="${tool}-redo-btn" aria-label="Redo last selection step" title="Redo last selection step">↪</button>
        <button type="button" class="btn btn-compact lasso-cancel" id="${tool}-cancel-btn" aria-keyshortcuts="Escape" title="Discard this selection (Esc)">Cancel</button>
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
  undoButton.disabled = !readout.canUndo;
  redoButton.disabled = !readout.canRedo;
  confirmButton.disabled = readout.candidateCount === 0;

  const mirror = selectBarMirror(documentOwner);
  if (mirror !== null) {
    mirror.steps.dataset.tool = tool;
    mirror.steps.hidden = false;
    mirror.selection.textContent = readout.candidateCount === 0
      ? 'No cells selected'
      : cellCountText(readout.candidateCount);
    mirror.undo.disabled = undoButton.disabled;
    mirror.confirm.disabled = confirmButton.disabled;
    publishSelectBarNotice(mirror, readout.notice);
  }
}
