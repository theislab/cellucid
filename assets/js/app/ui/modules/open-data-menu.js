/**
 * @fileoverview The "Open…" button of the Session panel: one button for
 * every local dataset, with a two-item menu.
 *
 * A browser's file dialog picks either files or one folder, never both, so
 * one button cannot open both an `.h5ad` / `.zarr.zip` file and a `.zarr`
 * folder with a single dialog. The button therefore opens a small menu --
 * "File…" and "Folder…" -- and each item opens its own dialog. What was
 * picked decides how it is read (`dataset-connections.js`). A file or folder
 * dropped anywhere on the page opens the same way (`dataset-drop.js`).
 *
 * Keyboard: Enter, Space or Down opens the menu on its first item, Up on its
 * last; Up, Down, Home and End move; Escape closes it and returns to the
 * button; Tab closes it.
 *
 * @module ui/modules/open-data-menu
 */

/**
 * @param {Object} options
 * @param {HTMLButtonElement} options.button
 * @param {HTMLElement} options.menu
 * @param {HTMLButtonElement[]} options.items - The menu items, in order
 * @param {(item: HTMLButtonElement) => void} options.onChoose - Runs inside
 *   the click, so a file dialog it opens is allowed
 * @param {AbortSignal} options.signal - Removes every listener
 * @returns {{close: () => void}}
 */
export function initOpenDataMenu({ button, menu, items, onChoose, signal }) {
  for (const [name, element] of Object.entries({ button, menu })) {
    if (element === null || typeof element?.addEventListener !== 'function') {
      throw new TypeError(`The open menu requires its ${name}.`);
    }
  }
  if (!Array.isArray(items) || items.length === 0 || items.some(item => typeof item?.focus !== 'function')) {
    throw new TypeError('The open menu requires its items.');
  }
  if (typeof onChoose !== 'function') throw new TypeError('The open menu requires onChoose.');
  const ownerDocument = button.ownerDocument;
  const options = { signal };

  const isOpen = () => !menu.hidden;

  function open(focusIndex) {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    items.at(focusIndex)?.focus();
  }

  function close({ restoreFocus = false } = {}) {
    if (!isOpen()) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus();
  }

  button.addEventListener('click', () => {
    if (isOpen()) close();
    else open(0);
  }, options);

  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open(event.key === 'ArrowDown' ? 0 : -1);
    } else if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      close({ restoreFocus: true });
    }
  }, options);

  menu.addEventListener('keydown', event => {
    const index = items.indexOf(ownerDocument.activeElement);
    const move = {
      ArrowDown: (index + 1) % items.length,
      ArrowUp: (index - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    }[event.key];
    if (move !== undefined) {
      event.preventDefault();
      items[move].focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close({ restoreFocus: true });
    } else if (event.key === 'Tab') {
      close();
    }
  }, options);

  for (const item of items) {
    item.addEventListener('click', () => {
      close({ restoreFocus: true });
      onChoose(item);
    }, options);
  }

  // A press anywhere else closes the menu.
  ownerDocument.addEventListener('pointerdown', event => {
    if (!isOpen()) return;
    const target = event.target;
    if (button.contains(target) || menu.contains(target)) return;
    close();
  }, { ...options, capture: true });
  menu.addEventListener('focusout', event => {
    const next = event.relatedTarget;
    if (next !== null && !menu.contains(next) && next !== button) close();
  }, options);

  signal.addEventListener('abort', () => close(), { once: true });
  return Object.freeze({ close });
}
