/**
 * @fileoverview The menus: one look and one set of keys for every list of
 * actions opened from a button or at a point.
 *
 * Two builders share them. `openMenu` builds a menu for the items of the
 * moment (a history row's context menu — right-click, Shift+F10, the Menu
 * key —, a branch's ⋯, the history search's Filter, a highlight page's
 * Combine); `initOpenDataMenu` (`ui/modules/open-data-menu.js`) binds a menu
 * written in the markup to its button (Open…, My datasets, the History
 * panel's ⋯). Both draw `.open-menu-list` of `.open-menu-item`
 * (`_session.css`) and answer the keys of `menuKeyDown`.
 *
 * Keys: ↑/↓ move (wrapping), Home/End go to the first or last item, Enter or
 * Space choose, Escape closes and returns to where the menu opened, Tab
 * closes it and moves on from there. An open menu is shown above the page
 * (moved to the end of the body, or of the open dialog holding its button),
 * so a Tab the browser took from an item would go past the last element of the
 * document and land on its first stop, the plot: the menu hands focus back to
 * its opener first, and
 * the browser's Tab moves on from there, to the control after the opener
 * (Shift+Tab, the one before it).
 *
 * An item that cannot be used now stays listed, disabled, with why as its
 * title: what exists is learned from the menu. A menu button
 * (`aria-haspopup="menu"`) says whether its menu is open (`aria-expanded`)
 * and names it while it is (`aria-controls`); `openMenu` owns that state.
 *
 * @module ui/components/menu
 */

import { StyleManager } from '../../../utils/style-manager.js';
import { createDomId } from './dom-id.js';

/**
 * Answer a key pressed in an open menu.
 *
 * @param {KeyboardEvent} event
 * @param {HTMLElement[]} items - The menu's items, in order
 * @param {(refocus: boolean) => void} close - Closes the menu; `refocus`
 *   puts focus back on where it opened
 * @returns {boolean} Whether the key was the menu's
 */
export function menuKeyDown(event, items, close) {
  const active = items.indexOf(event.target?.ownerDocument?.activeElement ?? null);
  const next = {
    ArrowDown: (active + 1) % items.length,
    ArrowUp: (active - 1 + items.length) % items.length,
    Home: 0,
    End: items.length - 1,
  }[event.key];
  if (next !== undefined) {
    event.preventDefault();
    items[next]?.focus();
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    close(true);
    return true;
  }
  if (event.key === 'Tab') {
    // Not prevented: the browser moves on from the opener focused here.
    close(true);
    return true;
  }
  return false;
}

let open = null;

/**
 * @typedef {{label: string, run?: () => void, disabled?: boolean, title?: string, hint?: string,
 *   checked?: boolean, danger?: boolean}|{separator: true}} MenuItem
 */

/**
 * Open a menu below `anchor`, or at a point. One is open at a time.
 *
 * @param {{anchor: Element, items: MenuItem[], label: string, returnFocus?: HTMLElement|null,
 *   at?: {x: number, y: number}|null}} options - `at`: a point to open at (a
 *   context menu at the pointer, a page dropped on another) instead of under
 *   the anchor; `returnFocus`: where focus goes back to (the anchor by default)
 * @returns {() => void} close
 */
export function openMenu({ anchor, items, label, returnFocus = null, at = null }) {
  open?.close(false);
  const doc = anchor.ownerDocument;
  const menu = doc.createElement('div');
  menu.id = createDomId('menu');
  menu.className = 'open-menu-list popup-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  const buttons = [];
  for (const item of items) {
    if ('separator' in item) {
      const rule = doc.createElement('div');
      rule.className = 'open-menu-separator';
      rule.setAttribute('role', 'separator');
      menu.append(rule);
      continue;
    }
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `open-menu-item${item.danger ? ' is-danger' : ''}`;
    button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
    button.tabIndex = -1;
    if (item.disabled) button.setAttribute('aria-disabled', 'true');
    if (item.title) button.title = item.title;
    const text = doc.createElement('span');
    text.className = 'open-menu-item-label';
    text.textContent = item.label;
    button.append(text);
    if (item.hint) {
      const hint = doc.createElement('span');
      hint.className = 'open-menu-item-hint';
      hint.textContent = item.hint;
      button.append(hint);
    }
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (item.disabled) return;
      close(true);
      item.run?.();
    });
    buttons.push(button);
    menu.append(button);
  }
  // Inside an open modal dialog (the branch map) the rest of the page is
  // inert: the menu is the dialog's, as an (i) tip is (`info-popovers.js`).
  (anchor.closest('dialog[open]') ?? doc.body).append(menu);
  // Below the anchor (ending at its right edge), or from the point it was
  // opened at; inside the window either way.
  const box = at === null ? anchor.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
  const size = menu.getBoundingClientRect();
  const view = doc.defaultView;
  const left = Math.max(8, Math.min(at === null ? box.right - size.width : box.left, view.innerWidth - size.width - 8));
  const top = box.bottom + size.height + 8 <= view.innerHeight ? box.bottom + 4 : Math.max(8, box.top - size.height - 4);
  StyleManager.setVariable(menu, '--popup-menu-left', `${left}px`);
  StyleManager.setVariable(menu, '--popup-menu-top', `${top}px`);

  // A menu button says its menu is open and which it is.
  const button = anchor.getAttribute('aria-haspopup') === 'menu' ? anchor : null;
  button?.setAttribute('aria-expanded', 'true');
  button?.setAttribute('aria-controls', menu.id);

  const controller = new AbortController();
  const back = returnFocus ?? (typeof anchor.focus === 'function' ? anchor : null);
  function close(refocus) {
    if (open?.menu !== menu) return;
    open = null;
    controller.abort();
    menu.remove();
    button?.setAttribute('aria-expanded', 'false');
    button?.removeAttribute('aria-controls');
    if (refocus) back?.focus({ preventScroll: true });
  }
  open = { menu, close };
  menu.addEventListener('keydown', event => {
    menuKeyDown(event, buttons, close);
  }, { signal: controller.signal });
  doc.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target) && event.target !== anchor) close(false);
  }, { signal: controller.signal, capture: true });
  (buttons.find(each => each.getAttribute('aria-disabled') !== 'true') ?? buttons[0])?.focus();
  return () => close(false);
}
