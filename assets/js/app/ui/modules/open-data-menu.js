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
 * last; in the menu, the keys of every menu (`menuKeyDown` in
 * `ui/components/menu.js`: Up, Down, Home and End move; Escape closes it and
 * returns to the button; Tab closes it and moves on from the button).
 *
 * The History panel's ⋯ menu and My datasets open the same way. Open, a
 * menu is shown above the page (moved to the body, or to the open dialog
 * that holds its button, at a fixed place under the button, or above it
 * when the window has no room below), never inside the panel it belongs
 * to: a sidebar section clips what overflows it (`.accordion-content`), and
 * a floating panel is a box of its own (`transform`, `overflow: hidden`), so
 * a menu at the bottom of the State section was cut off. It keeps its width
 * and its alignment with the button, goes back in place when it closes, and
 * closes when the page under it scrolls (it would leave its button).
 *
 * @module ui/modules/open-data-menu
 */

import { onAbort } from '../../../utils/abort.js';
import { menuKeyDown } from '../components/menu.js';
import { StyleManager } from '../../../utils/style-manager.js';
import { holdPlace } from '../../utils/dom-utils.js';

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
  /** Where the menu sits in the page while closed (it is moved above the page while open). */
  let home = null;

  /** Show the menu above the page, where it lays out under its button, inside the window. */
  function place() {
    const natural = menu.getBoundingClientRect();
    const anchor = button.getBoundingClientRect();
    home = { parent: menu.parentNode, goBack: holdPlace(menu), anchor: { top: anchor.top, left: anchor.left } };
    (button.closest('dialog[open]') ?? ownerDocument.body).append(menu);
    menu.classList.add('open-menu-placed');
    const view = ownerDocument.defaultView;
    const width = Math.min(natural.width, view.innerWidth - 16);
    StyleManager.setVariable(menu, '--open-menu-width', `${width}px`);
    const height = menu.offsetHeight;
    const gap = natural.top - anchor.bottom;
    const left = Math.max(8, Math.min(natural.left, view.innerWidth - width - 8));
    const below = anchor.bottom + gap;
    const top = below + height + 8 <= view.innerHeight ? below : Math.max(8, anchor.top - gap - height);
    StyleManager.setVariable(menu, '--open-menu-left', `${left}px`);
    StyleManager.setVariable(menu, '--open-menu-top', `${top}px`);
  }

  function putBack() {
    if (home === null) return;
    menu.classList.remove('open-menu-placed');
    if (home.parent?.isConnected && !home.goBack()) home.parent.append(menu);
    home = null;
  }

  function open(focusIndex) {
    // An arrow key on the button of an open menu only moves focus: the menu
    // is placed once, from where it lives in the page.
    if (!isOpen()) {
      menu.hidden = false;
      place();
      button.setAttribute('aria-expanded', 'true');
    }
    items.at(focusIndex)?.focus({ preventScroll: true });
  }

  function close({ restoreFocus = false } = {}) {
    if (!isOpen()) return;
    menu.hidden = true;
    putBack();
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus({ preventScroll: true });
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
    menuKeyDown(event, items, refocus => close({ restoreFocus: refocus }));
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
  // Shown at a fixed place, the menu would leave its button when the page
  // under it scrolls. Only a scroll that moved the button closes it: a
  // scroll event is told a frame after the scroll, so the one of focusing
  // the button (scrolled into view, then Enter at once) arrives after the
  // menu opened, where the button already was.
  ownerDocument.addEventListener('scroll', event => {
    const scrolled = event.target === ownerDocument ? ownerDocument.documentElement : event.target;
    if (!isOpen() || typeof scrolled?.contains !== 'function' || !scrolled.contains(button)) return;
    const now = button.getBoundingClientRect();
    const then = home?.anchor ?? null;
    if (then === null || now.top !== then.top || now.left !== then.left) close();
  }, { ...options, capture: true });
  ownerDocument.defaultView?.addEventListener('resize', () => close(), options);
  menu.addEventListener('focusout', event => {
    const next = event.relatedTarget;
    if (next !== null && !menu.contains(next) && next !== button) close();
  }, options);

  onAbort(signal, () => {
    close();
    putBack();
  });
  return Object.freeze({ close });
}
