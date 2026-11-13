/**
 * Multi-select Dropdown (Popup with tickers)
 *
 * Reusable UI component for selecting multiple items from a list using checkboxes.
 * Designed to match existing dropdown/popup styling in the app (paper box, black border, shadow).
 *
 * The popup is anchored to its button and non-modal, as the group picker's
 * (`group-picker.js`): a native popover (`popover="auto"`) its button opens
 * (`popovertarget`), so the browser shows it in the top layer, puts it next in
 * the focus order after the button, and closes it on Escape or a press
 * outside. It is no modal dialog: the page stays usable while it is open
 * (no `aria-modal`, no hand-made Tab trap).
 */

import {
  ICONS,
  coalesceToFrame,
  createButton,
  createEmptyState,
  createIconButton
} from '../../../ui/components/controls.js';
import { StyleManager } from '../../../../utils/style-manager.js';


/**
 * @typedef {Object} MultiSelectItem
 * @property {string} key
 * @property {string} label
 */

/**
 * @typedef {Object} MultiSelectDropdownOptions
 * @property {string} id - Unique id prefix for DOM ids
 * @property {string} buttonLabel - Accessible label and tooltip of the toggle button (drawn as `ICONS.more`)
 * @property {string} title - Title shown in the popup
 * @property {MultiSelectItem[]} items - List of selectable items
 * @property {Iterable<string>} selectedKeys - Currently selected keys
 * @property {(nextSelectedKeys: string[]) => void} onApply - Called when user applies selection
 * @property {number} [maxListHeight=240] - Max height (px) for the scrollable list
 * @property {boolean} [enableSearch=true] - Whether to show a filter input
 */

/**
 * Create a multi-select dropdown component.
 * @param {MultiSelectDropdownOptions} options
 * @returns {{ element: HTMLElement, destroy: Function }}
 */
export function createMultiSelectDropdown(options) {
  const {
    id,
    buttonLabel,
    title,
    items,
    selectedKeys,
    onApply,
    maxListHeight = 240,
    enableSearch = true
  } = options || {};

  if (!id) throw new Error('createMultiSelectDropdown: missing required option "id"');
  if (!buttonLabel) throw new Error('createMultiSelectDropdown: missing required option "buttonLabel"');
  if (!title) throw new Error('createMultiSelectDropdown: missing required option "title"');
  if (!Array.isArray(items)) throw new Error('createMultiSelectDropdown: "items" must be an array');
  if (typeof onApply !== 'function') throw new Error('createMultiSelectDropdown: "onApply" must be a function');

  const wrapper = document.createElement('div');
  wrapper.className = 'multi-select-dropdown';

  const btn = createIconButton({ label: buttonLabel, icon: ICONS.more, className: 'multi-select-dropdown-btn' });
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', `${id}-panel`);
  btn.setAttribute('popovertarget', `${id}-panel`);
  wrapper.appendChild(btn);

  const panel = document.createElement('div');
  panel.className = 'multi-select-dropdown-panel';
  panel.id = `${id}-panel`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', title);
  panel.setAttribute('popover', 'auto');
  // Beside its button (a popover is drawn in the top layer, wherever it
  // sits), as the group picker's: inside a modal dialog (the expanded view)
  // a panel under `body` would be inert.
  wrapper.appendChild(panel);

  const header = document.createElement('div');
  header.className = 'multi-select-dropdown-header';
  panel.appendChild(header);

  const titleEl = document.createElement('div');
  titleEl.className = 'multi-select-dropdown-title';
  titleEl.textContent = title;
  header.appendChild(titleEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'multi-select-dropdown-meta';
  header.appendChild(metaEl);

  /** @type {MultiSelectItem[]} */
  let currentItems = items.slice();
  /** @type {Set<string>} */
  let committedSelected = new Set(selectedKeys || []);
  /** @type {Set<string>} */
  let pendingSelected = new Set(committedSelected);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'obs-select multi-select-dropdown-search';
  searchInput.placeholder = 'Filter…';
  searchInput.setAttribute('aria-label', `Filter ${title}`);
  searchInput.autocomplete = 'off';
  if (enableSearch) {
    panel.appendChild(searchInput);
  }

  const list = document.createElement('div');
  list.className = 'multi-select-dropdown-list';
  StyleManager.setVariable(
    list,
    '--multi-select-list-max-height',
    `${Math.max(120, maxListHeight)}px`
  );
  panel.appendChild(list);

  // One delegated listener records every checkbox change in the list.
  list.addEventListener('change', (event) => {
    const checkbox = event.target;
    if (!(checkbox instanceof HTMLInputElement) || checkbox.type !== 'checkbox') return;
    const key = checkbox.dataset.key;
    if (checkbox.checked) pendingSelected.add(key);
    else pendingSelected.delete(key);
    updateMeta();
  });

  const actions = document.createElement('div');
  actions.className = 'multi-select-dropdown-actions';
  panel.appendChild(actions);

  const hideAllBtn = createButton({ label: 'Hide all', className: 'btn-compact' });
  actions.appendChild(hideAllBtn);

  const showAllBtn = createButton({ label: 'Show all', className: 'btn-compact' });
  actions.appendChild(showAllBtn);

  // Apply commits the choice, so it is the panel's one primary action.
  const applyBtn = createButton({
    label: 'Apply',
    variant: 'primary',
    className: 'btn-compact'
  });
  actions.appendChild(applyBtn);

  const updateMeta = () => {
    metaEl.textContent = `${pendingSelected.size}/${currentItems.length}`;
    btn.title = `${title} (${committedSelected.size} selected)`;
  };

  const renderList = () => {
    const q = enableSearch ? (searchInput.value || '').trim().toLowerCase() : '';
    const filtered = q
      ? currentItems.filter(it =>
        (it.label || it.key).toLowerCase().includes(q) ||
        it.key.toLowerCase().includes(q)
      )
      : currentItems;

    if (filtered.length === 0) {
      list.replaceChildren(createEmptyState('No matches.'));
      updateMeta();
      return;
    }

    // Rows are built off-document and inserted in one step.
    const fragment = document.createDocumentFragment();
    for (const it of filtered) {
      const row = document.createElement('label');
      row.className = 'checkbox-inline multi-select-dropdown-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.key = it.key;
      checkbox.checked = pendingSelected.has(it.key);

      const labelText = it.label || it.key;
      const labelEl = document.createElement('span');
      labelEl.className = 'multi-select-dropdown-label';
      labelEl.textContent = labelText;
      labelEl.title = labelText;

      row.appendChild(checkbox);
      row.appendChild(labelEl);
      fragment.appendChild(row);
    }
    list.replaceChildren(fragment);

    updateMeta();
  };

  const isOpen = () => panel.matches(':popover-open');
  let openAbortController = null;
  /** Whether focus was in the popup as it closed (it then goes back to the button). */
  let focusWasInside = false;
  /** A close that must not move focus (the component torn down). */
  let keepFocusOnClose = false;

  const updatePanelPosition = () => {
    const btnRect = btn.getBoundingClientRect();
    panel.style.top = `${btnRect.bottom + 4}px`;
    panel.style.left = `${btnRect.left}px`;
  };
  // Every scroll in the document fires the capture listener below; the panel
  // only needs its position once per frame, read and written together.
  const repositionPanel = coalesceToFrame(updatePanelPosition);

  const close = ({ restoreFocus = true } = {}) => {
    if (!isOpen()) return;
    keepFocusOnClose = !restoreFocus;
    panel.hidePopover();
  };

  // Opening and closing, however asked (the button, Escape, a press outside,
  // Apply): `beforetoggle` comes while focus is still inside the popup.
  panel.addEventListener('beforetoggle', (event) => {
    if (event.newState === 'open') {
      pendingSelected = new Set(committedSelected);
      if (enableSearch) searchInput.value = '';
      renderList();
      updatePanelPosition();
      return;
    }
    focusWasInside = !keepFocusOnClose && panel.contains(document.activeElement);
    keepFocusOnClose = false;
  });
  panel.addEventListener('toggle', (event) => {
    const opened = event.newState === 'open';
    btn.setAttribute('aria-expanded', String(opened));
    if (opened) {
      openAbortController = new AbortController();
      // Update position on scroll (capture to catch scrolls from any ancestor)
      document.addEventListener('scroll', () => repositionPanel(), { signal: openAbortController.signal, capture: true });
      // Start on the filter box, or the first control when there is none.
      const initialFocus = enableSearch ? searchInput : panel.querySelector('button, input');
      initialFocus?.focus({ preventScroll: true });
      return;
    }
    openAbortController?.abort();
    openAbortController = null;
    repositionPanel.cancel();
    if (focusWasInside && btn.isConnected) btn.focus({ preventScroll: true });
    focusWasInside = false;
    // Reset pending state so next open reflects committed selection.
    pendingSelected = new Set(committedSelected);
    if (enableSearch) searchInput.value = '';
  });

  // The button opens and closes the popup itself (`popovertarget`); its click
  // stays out of the panel header it sits in.
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  if (enableSearch) {
    searchInput.addEventListener('input', () => renderList());
  }

  hideAllBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pendingSelected.clear();
    renderList();
  });

  showAllBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const it of currentItems) {
      pendingSelected.add(it.key);
    }
    renderList();
  });

  applyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    committedSelected = new Set(pendingSelected);
    updateMeta();
    close();
    onApply(Array.from(committedSelected));
  });

  // Initial render of title/meta
  updateMeta();

  const destroy = () => {
    // Teardown must not pull focus back to a button that is about to be removed.
    close({ restoreFocus: false });
    wrapper.innerHTML = '';
    // Remove panel from body
    if (panel.parentNode) {
      panel.parentNode.removeChild(panel);
    }
  };

  return { element: wrapper, destroy };
}
