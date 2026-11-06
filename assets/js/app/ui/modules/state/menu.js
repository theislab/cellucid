/**
 * @fileoverview A menu of the history opened at a row or a button: a row's
 * context menu (right-click, Shift+F10, the Menu key), a branch's ⋯, the
 * search's Filter. It is the Open… menu's look and keys (`open-data-menu.js`:
 * `.open-menu-list` of `.open-menu-item`; ↑/↓, Home/End, Enter or Space,
 * Escape back to where it opened, Tab or a press elsewhere closes), built for
 * the items of the moment. One is open at a time.
 *
 * An item that cannot be used now stays listed, disabled, with why as its
 * title: what exists is learned from the menu.
 *
 * @module ui/modules/state/menu
 */

import { StyleManager } from '../../../../utils/style-manager.js';

let open = null;

/**
 * @typedef {{label: string, run?: () => void, disabled?: boolean, title?: string, hint?: string,
 *   checked?: boolean, danger?: boolean}|{separator: true}} MenuItem
 */

/**
 * Open a menu below `anchor`.
 *
 * @param {{anchor: Element, items: MenuItem[], label: string, returnFocus?: HTMLElement|null, at?: {x: number, y: number}|null}} options -
 *   `at`: a point to open at (a context menu at the pointer) instead of under the anchor
 * @returns {() => void} close
 */
export function openMenu({ anchor, items, label, returnFocus = null, at = null }) {
  open?.close(false);
  const doc = anchor.ownerDocument;
  const menu = doc.createElement('div');
  menu.className = 'open-menu-list history-popup-menu';
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
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const view = doc.defaultView;
  const left = Math.max(8, Math.min(at === null ? box.right - width : box.left, view.innerWidth - width - 8));
  const top = box.bottom + height + 8 <= view.innerHeight ? box.bottom + 4 : Math.max(8, box.top - height - 4);
  StyleManager.setVariable(menu, '--history-menu-left', `${left}px`);
  StyleManager.setVariable(menu, '--history-menu-top', `${top}px`);

  const controller = new AbortController();
  const back = returnFocus ?? (anchor instanceof HTMLElement ? anchor : null);
  function close(refocus) {
    if (open?.menu !== menu) return;
    open = null;
    controller.abort();
    menu.remove();
    if (refocus) back?.focus({ preventScroll: true });
  }
  open = { menu, close };
  const enabled = () => buttons.filter(button => button.getAttribute('aria-disabled') !== 'true');
  menu.addEventListener('keydown', event => {
    const list = buttons;
    const at = list.indexOf(doc.activeElement);
    let next = null;
    switch (event.key) {
      case 'ArrowDown': next = list[(at + 1) % list.length]; break;
      case 'ArrowUp': next = list[(at - 1 + list.length) % list.length]; break;
      case 'Home': next = list[0]; break;
      case 'End': next = list[list.length - 1]; break;
      case 'Escape': event.preventDefault(); close(true); return;
      case 'Tab': close(false); return;
      default: return;
    }
    event.preventDefault();
    next?.focus();
  }, { signal: controller.signal });
  doc.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target) && event.target !== anchor) close(false);
  }, { signal: controller.signal, capture: true });
  (enabled()[0] ?? buttons[0])?.focus();
  return () => close(false);
}

/** Close the menu that is open, if any. */
export function closeMenu() {
  open?.close(false);
}
