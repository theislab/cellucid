/**
 * @fileoverview Every modal dialog in the app: a native `<dialog>` opened
 * with `showModal()` through `wireAppDialog`.
 *
 * The browser gives a modal `<dialog>` the backdrop (`::backdrop`), the inert
 * page behind it (no focus, no clicks, nothing read by a screen reader), the
 * top layer (above every floating panel and window whatever their z-index),
 * Escape (the `cancel` event), stacking (a dialog opened over another is the
 * one in use; closing it hands the page back to the one below) and the return
 * of focus when focus was inside it. This helper adds what it does not:
 *
 * - a close button (`[data-dialog-close]`) and a click on the backdrop close it
 *   (a press and a release both on the backdrop: a text selection dragged out
 *   of the card does not);
 * - focus returns to the opener even when a mouse click never focused it
 *   (WebKit does not focus a clicked link or button), or to what a function
 *   names at close time when the opener is gone;
 * - keys pressed inside the dialog stay in it: the page's own keys (the camera,
 *   the shortcuts, Escape leaving a selection or a tour) never act behind an
 *   open dialog. Listeners in the capture phase still see them first, which is
 *   how a tip or popover shown inside the dialog takes its own Escape;
 * - `close()` settles at once (focus back, `onClose`), where the native `close`
 *   event comes a task later; a close by Escape or the backdrop settles on that
 *   event;
 * - a dialog under the topmost is made inert itself (`inert`), as the stacking
 *   promises, and given back when it is the topmost again: Linux's WebKit let
 *   focus into a dialog under a confirmation;
 * - what must stay usable over any dialog (the notification cards) moves into
 *   the topmost open one (`keepAboveModals`) and back when the last closes:
 *   outside it, it would be inert.
 *
 * There is no other modal implementation: no overlay `div`, no Tab trap, no
 * `aria-modal`. Content that handles Escape itself (an inline editor, a
 * combobox's suggestions) calls `preventDefault()` on the key, and the dialog
 * stays open.
 *
 * @module ui/components/app-dialog
 */

/** Open modal dialogs, the topmost last. */
const openModals = [];

/** Dialogs this module made inert because another opened over them. */
const coveredModals = new Set();

/** Elements kept inside the topmost dialog → where they live without one. */
const followers = new Map();

function topModal() {
  for (let index = openModals.length - 1; index >= 0; index -= 1) {
    const dialog = openModals[index];
    if (dialog.open && dialog.isConnected) return dialog;
  }
  return null;
}

/**
 * A dialog under the topmost is inert, set here and not only left to the
 * browser: Linux's WebKit (Playwright's WPE build, as GNOME Web) still let a
 * control of a dialog under a confirmation take focus (CI run 43106620008,
 * `community-annotation-cap-voting.spec.mjs`), where the stacking a modal
 * dialog promises makes everything outside the topmost unreachable. The
 * attribute is taken off when the dialog is the topmost again.
 */
function coverModalsBelowTop() {
  const top = topModal();
  for (const dialog of openModals) {
    if (dialog === top || !dialog.open || !dialog.isConnected) continue;
    if (coveredModals.has(dialog) || dialog.inert) continue;
    dialog.inert = true;
    coveredModals.add(dialog);
  }
  for (const dialog of [...coveredModals]) {
    if (dialog !== top && openModals.includes(dialog) && dialog.open && dialog.isConnected) continue;
    dialog.inert = false;
    coveredModals.delete(dialog);
  }
}

/**
 * Put `element` back where `home` says it lived: before the sibling it stood
 * before. That sibling may itself be kept above dialogs and not home yet (two
 * followers side by side: the notification center and the agents' dock); the
 * place is then before the sibling *it* goes back before, and so on, so every
 * follower ends where it was whatever the order they go home in. Before, the
 * first of two neighbors to go home found its sibling away and was put at
 * the end of its parent: the two had swapped places, and with them which of
 * the two is drawn over the other (found 2026-11-12, Firefox,
 * `community-annotation-cap-voting.spec.mjs`).
 */
function goHome(element, home) {
  const { parent } = home;
  if (parent === null) return;
  let anchor = home.next;
  while (anchor !== null && anchor.parentNode !== parent) {
    const away = followers.get(anchor)?.home ?? null;
    anchor = away !== null && away.parent === parent ? away.next : null;
  }
  if (anchor !== null) parent.insertBefore(element, anchor);
  else parent.append(element);
}

function placeFollowers() {
  coverModalsBelowTop();
  const top = topModal();
  for (const [element, state] of followers) {
    if (top !== null) {
      state.home ??= { parent: element.parentNode, next: element.nextSibling };
      if (element.parentNode !== top) top.append(element);
      continue;
    }
    if (state.home === null) continue;
    // Its home is known to the others until it is back in it (`goHome`).
    goHome(element, state.home);
    state.home = null;
  }
}

/**
 * Keep an element usable over every modal dialog: while one is open the
 * element lives inside the topmost, and it goes back where it was when the
 * last one closes.
 *
 * @param {HTMLElement} element
 * @returns {() => boolean} Release (true the first time).
 */
export function keepAboveModals(element) {
  if (element === null || typeof element !== 'object') {
    throw new TypeError('Only an element can be kept above dialogs.');
  }
  if (followers.has(element)) {
    throw new Error('This element is already kept above dialogs.');
  }
  const state = { home: null };
  followers.set(element, state);
  placeFollowers();
  return () => {
    if (followers.get(element) !== state) return false;
    if (state.home !== null) {
      goHome(element, state.home);
      state.home = null;
    }
    followers.delete(element);
    return true;
  };
}

/** A control focus can go back to: still in the page, enabled, not the body. */
function canTakeFocus(target) {
  return (
    target instanceof HTMLElement &&
    target.isConnected &&
    target !== target.ownerDocument.body &&
    !target.matches(':disabled')
  );
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {{onClose?: (() => void) | null}} [options] - `onClose` runs once
 *   per open, after focus went back, however the dialog closed.
 *   `dismissible: false`: Escape and the backdrop leave it open, for a
 *   dialog the page cannot be used behind (the graphics reset); it closes
 *   only through `close()`.
 * @returns {{
 *   open: (opener?: HTMLElement | (() => HTMLElement | null) | null,
 *          options?: {focus?: HTMLElement | null}) => void,
 *   close: () => void,
 *   destroy: () => void
 * }}
 */
export function wireAppDialog(dialog, { onClose = null, dismissible = true } = {}) {
  // Read at call time: a module importing this one loads where there is no DOM.
  if (typeof HTMLDialogElement === 'undefined' || !(dialog instanceof HTMLDialogElement)) {
    throw new TypeError('An app dialog must be a <dialog> element.');
  }
  if (onClose !== null && typeof onClose !== 'function') {
    throw new TypeError('An app dialog onClose must be a function or null.');
  }
  if (typeof dismissible !== 'boolean') {
    throw new TypeError('An app dialog is dismissible or not (a boolean).');
  }
  const controller = new AbortController();
  const { signal } = controller;
  /** Where focus goes back to, while the dialog is open; null while closed. */
  let session = null;

  const settle = () => {
    if (session === null) return;
    const { returnTo, before } = session;
    session = null;
    const index = openModals.indexOf(dialog);
    if (index >= 0) openModals.splice(index, 1);
    placeFollowers();
    // A close by Escape or the backdrop settles a task later (the native
    // `close` event): focus that moved on meanwhile (a row the person, or a
    // key, focused right after Escape) stays where it went. Focus is taken
    // back only from the dialog, the body (focus lost with the dialog), or
    // where the browser put it back itself (what was focused at open). F260:
    // under load, F2's rename dialog closed by Escape took focus back from the
    // step row focused next, and Delete then acted on the branch row.
    const active = dialog.ownerDocument.activeElement;
    const movedOn = active !== null && active !== dialog.ownerDocument.body && !dialog.contains(active) && active !== before;
    const target = typeof returnTo === 'function' ? returnTo() : returnTo;
    if (!movedOn && canTakeFocus(target)) target.focus({ preventScroll: true });
    onClose?.();
  };

  dialog.addEventListener('close', () => {
    // A close event queued before the dialog was opened again belongs to
    // the earlier opening, which close() already settled.
    if (!dialog.open) settle();
  }, { signal });
  for (const button of dialog.querySelectorAll('[data-dialog-close]')) {
    button.addEventListener('click', () => close(), { signal });
  }
  // The dialog's own box is only ever the target on the backdrop (its content
  // fills it), and only a press that started there too is a click on it.
  let pressedOnBackdrop = false;
  dialog.addEventListener('pointerdown', event => {
    pressedOnBackdrop = event.target === dialog;
  }, { signal });
  dialog.addEventListener('click', event => {
    const onBackdrop = event.target === dialog && pressedOnBackdrop;
    pressedOnBackdrop = false;
    if (onBackdrop && dismissible) close();
  }, { signal });
  if (!dismissible) dialog.addEventListener('cancel', event => event.preventDefault(), { signal });
  dialog.addEventListener('keydown', event => event.stopPropagation(), { signal });

  function close() {
    if (dialog.open) dialog.close();
    settle();
  }

  return {
    /**
     * @param {HTMLElement | (() => HTMLElement | null) | null} [opener] -
     *   Where focus returns on close (a function is asked at close time); the
     *   focused element when omitted.
     * @param {{focus?: HTMLElement | null}} [options] - What takes focus on
     *   open; the browser's choice (the first control, or the dialog itself
     *   when it carries `autofocus`) when omitted.
     */
    open(opener = null, { focus = null } = {}) {
      if (dialog.open) return;
      const before = dialog.ownerDocument.activeElement;
      const returnTo = opener ?? before;
      dialog.showModal();
      session = { returnTo, before };
      openModals.push(dialog);
      placeFollowers();
      if (focus !== null) focus.focus({ preventScroll: true });
    },
    close,
    destroy() {
      close();
      controller.abort();
    },
  };
}
