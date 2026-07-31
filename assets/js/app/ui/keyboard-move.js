/**
 * @fileoverview One keyboard grammar for "move this thing to that place".
 *
 * Cellucid moves things with the pointer in three places: a sidebar panel is
 * torn off into a floating window, a highlight page is dropped into the
 * category builder and reordered inside it, and a legend category is dragged
 * onto another category to merge the two. A pointer drag has no keyboard
 * equivalent of its own, so each of those surfaces needs one, and they need to
 * be the *same* one — a user who learns the gesture in the legend must not have
 * to learn a second gesture in the category builder.
 *
 * The grammar is:
 *
 *   pick up   Enter or Space on a focusable, self-describing handle
 *   aim       ArrowUp/ArrowDown (or ArrowLeft/ArrowRight), Home, End walk the
 *             ordered list of legal destinations; each step is announced
 *   drop      Enter or Space commits to the aimed destination
 *   cancel    Escape, or moving focus away, restores the starting state
 *
 * When a surface has exactly one legal destination the aim step has nothing to
 * choose and collapses: the handle is a plain command control that commits on
 * activation. That is the dockable panel case — a panel is either docked or
 * floating, so its current state already names the only place it can go.
 *
 * Announcements go to a polite, visually hidden live region owned by this
 * module rather than to the notification centre. The notification centre is a
 * visible toast stack with a four-item cap that evicts older entries; narrating
 * every aim step through it would paper the screen over and push real
 * notifications out. Committed outcomes that already publish a toast keep
 * publishing it — this region carries only the in-flight state a sighted user
 * reads off the drag highlight.
 *
 * @module ui/keyboard-move
 */

const LIVE_REGION_ID = 'keyboard-move-live-region';
const INSTRUCTIONS_ID = 'keyboard-move-instructions';
const INSTRUCTIONS_TEXT =
  'Press Enter or Space to pick this up, arrow keys to choose where it goes, '
  + 'Enter to drop it there, and Escape to cancel.';

const AIM_FORWARD_KEYS = new Set(['ArrowDown', 'ArrowRight']);
const AIM_BACKWARD_KEYS = new Set(['ArrowUp', 'ArrowLeft']);
const ACTIVATION_KEYS = new Set(['Enter', ' ', 'Spacebar']);

function requireOwnerDocument(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || value.defaultView === null
    || value.defaultView === undefined
    || typeof value.createElement !== 'function'
  ) {
    throw new TypeError(`${label} must be one document with a default view`);
  }
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== 'function') {
    throw new TypeError(`${label} must be a function`);
  }
  return value;
}

function requireMessage(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
  ) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function ensureHiddenElement(ownerDocument, id, configure) {
  const existing = ownerDocument.getElementById(id);
  if (existing !== null) return existing;
  const element = ownerDocument.createElement('div');
  element.id = id;
  element.className = 'sr-only';
  configure(element);
  ownerDocument.body.appendChild(element);
  return element;
}

/**
 * The id of the shared, visually hidden element that spells the grammar out.
 *
 * Every movable handle points at it with `aria-describedby`, so the keys are
 * announced by the handle itself instead of living only in documentation.
 *
 * @param {Document} ownerDocument
 * @returns {string}
 */
export function getKeyboardMoveInstructionsId(ownerDocument) {
  requireOwnerDocument(ownerDocument, 'Keyboard move instructions document');
  ensureHiddenElement(ownerDocument, INSTRUCTIONS_ID, (element) => {
    element.textContent = INSTRUCTIONS_TEXT;
  });
  return INSTRUCTIONS_ID;
}

/**
 * Speak one move-state change politely without painting anything on screen.
 *
 * @param {Document} ownerDocument
 * @param {string} message
 */
export function announceKeyboardMove(ownerDocument, message) {
  requireOwnerDocument(ownerDocument, 'Keyboard move announcement document');
  requireMessage(message, 'Keyboard move announcement');
  const region = ensureHiddenElement(
    ownerDocument,
    LIVE_REGION_ID,
    (element) => {
      element.setAttribute('role', 'status');
      element.setAttribute('aria-live', 'polite');
      element.setAttribute('aria-atomic', 'true');
    }
  );
  // Assistive technology ignores a live region rewritten with identical text,
  // and two consecutive moves onto the same destination produce identical text.
  region.textContent = '';
  region.textContent = message;
}

/**
 * Build one keyboard move controller for a single movable handle.
 *
 * @param {object} options
 * @param {Document} options.ownerDocument
 * @param {() => string} options.describeSource Name of the thing being moved.
 * @param {() => Array<{element: HTMLElement, label: string}>} options.listTargets
 *   Ordered legal destinations, recomputed on every pick-up so a stale list can
 *   never be committed against.
 * @param {(aimed: object | null, previous: object | null) => void} options.onAim
 *   Paints and unpaints the destination. Surfaces reuse the same class their
 *   pointer path already applies, so both inputs look identical.
 * @param {(aimed: object, index: number, total: number) => void} options.onCommit
 * @param {(picked: boolean) => void} options.onPickStateChange
 * @param {string} options.emptyMessage Spoken when there is nowhere to go.
 * @returns {{handleKeydown: (event: KeyboardEvent) => boolean, cancel: (options?: {silent?: boolean}) => void, isPicked: () => boolean}}
 */
export function createKeyboardMove(options) {
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
  ) {
    throw new TypeError('Keyboard move requires one options record');
  }
  const {
    ownerDocument,
    describeSource,
    listTargets,
    onAim,
    onCommit,
    onPickStateChange,
    emptyMessage
  } = options;
  requireOwnerDocument(ownerDocument, 'Keyboard move document');
  requireFunction(describeSource, 'Keyboard move describeSource');
  requireFunction(listTargets, 'Keyboard move listTargets');
  requireFunction(onAim, 'Keyboard move onAim');
  requireFunction(onCommit, 'Keyboard move onCommit');
  requireFunction(onPickStateChange, 'Keyboard move onPickStateChange');
  requireMessage(emptyMessage, 'Keyboard move emptyMessage');

  /** @type {Array<{element: HTMLElement, label: string}> | null} */
  let targets = null;
  let index = -1;

  function requireTargets(candidates) {
    if (!Array.isArray(candidates)) {
      throw new TypeError('Keyboard move destinations must be an array');
    }
    for (const candidate of candidates) {
      if (
        candidate === null
        || typeof candidate !== 'object'
        || Array.isArray(candidate)
      ) {
        throw new TypeError('Keyboard move destination must be a record');
      }
      requireMessage(candidate.label, 'Keyboard move destination label');
    }
    return candidates;
  }

  function describeAim() {
    return `Destination ${index + 1} of ${targets.length}: ${targets[index].label}.`;
  }

  function aimAt(nextIndex) {
    const previous = index >= 0 ? targets[index] : null;
    index = nextIndex;
    onAim(targets[index], previous);
  }

  function release() {
    const previous = index >= 0 && targets !== null ? targets[index] : null;
    targets = null;
    index = -1;
    onAim(null, previous);
    onPickStateChange(false);
  }

  function cancel(cancelOptions = {}) {
    if (targets === null) return;
    const source = describeSource();
    release();
    if (cancelOptions.silent !== true) {
      announceKeyboardMove(
        ownerDocument,
        `Move cancelled. ${source} stayed where it was.`
      );
    }
  }

  function pickUp() {
    const candidates = requireTargets(listTargets());
    if (candidates.length === 0) {
      announceKeyboardMove(ownerDocument, emptyMessage);
      return;
    }
    targets = candidates;
    index = -1;
    onPickStateChange(true);
    aimAt(0);
    announceKeyboardMove(
      ownerDocument,
      `${describeSource()} picked up. ${describeAim()} `
      + 'Arrow keys change the destination, Enter drops it there, '
      + 'Escape cancels.'
    );
  }

  function commit() {
    const aimed = targets[index];
    const position = index;
    const total = targets.length;
    release();
    onCommit(aimed, position, total);
  }

  function handleKeydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return false;

    if (targets === null) {
      if (!ACTIVATION_KEYS.has(event.key)) return false;
      event.preventDefault();
      event.stopPropagation();
      pickUp();
      return true;
    }

    if (ACTIVATION_KEYS.has(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      commit();
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return true;
    }
    if (AIM_FORWARD_KEYS.has(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      aimAt((index + 1) % targets.length);
      announceKeyboardMove(ownerDocument, describeAim());
      return true;
    }
    if (AIM_BACKWARD_KEYS.has(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      aimAt((index - 1 + targets.length) % targets.length);
      announceKeyboardMove(ownerDocument, describeAim());
      return true;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      aimAt(0);
      announceKeyboardMove(ownerDocument, describeAim());
      return true;
    }
    if (event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      aimAt(targets.length - 1);
      announceKeyboardMove(ownerDocument, describeAim());
      return true;
    }
    return false;
  }

  return {
    handleKeydown,
    cancel,
    isPicked: () => targets !== null
  };
}
