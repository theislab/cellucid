/**
 * @fileoverview The small native dialogs (Cite Cellucid, Share this dataset).
 *
 * A `<dialog class="app-dialog">` opened with `showModal()` gets the backdrop,
 * the inert page, the focus trap, Escape, and the return of focus to its
 * opener from the browser. This helper adds what it does not: a close button
 * (`[data-dialog-close]`), closing on a click on the backdrop, and returning
 * focus to the opener even when a mouse click never focused it (WebKit does
 * not focus a clicked link or button, so the browser has nothing to return to).
 *
 * @module ui/components/app-dialog
 */

/**
 * @param {HTMLDialogElement} dialog
 * @returns {{open: () => void, close: () => void, destroy: () => void}}
 */
export function wireAppDialog(dialog) {
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new TypeError('An app dialog must be a <dialog> element.');
  }
  const controller = new AbortController();
  const { signal } = controller;
  let returnTo = null;
  dialog.addEventListener('close', () => {
    const target = returnTo;
    returnTo = null;
    if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
  }, { signal });
  for (const button of dialog.querySelectorAll('[data-dialog-close]')) {
    button.addEventListener('click', () => dialog.close(), { signal });
  }
  // A click whose target is the dialog itself landed on the backdrop: the
  // content fills the dialog's box, so no click inside it targets the dialog.
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  }, { signal });
  // Escape with an (i) tip open closes the tip, not the dialog under it.
  dialog.addEventListener('cancel', event => {
    if (dialog.querySelector('.info-tooltip:not([hidden])') !== null) event.preventDefault();
  }, { signal });
  return {
    /** @param {HTMLElement|null} [opener] - Where focus returns on close. */
    open(opener = null) {
      if (dialog.open) return;
      returnTo = opener ?? dialog.ownerDocument.activeElement;
      dialog.showModal();
    },
    close() {
      if (dialog.open) dialog.close();
    },
    destroy() {
      controller.abort();
      if (dialog.open) dialog.close();
    },
  };
}

/**
 * Copy text and say so on the button for a moment.
 *
 * @param {HTMLButtonElement} button
 * @param {string} text
 */
export async function copyWithFeedback(button, text) {
  const label = button.dataset.label ?? button.textContent;
  button.dataset.label = label;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  window.setTimeout(() => {
    button.textContent = button.dataset.label;
  }, 1400);
}
