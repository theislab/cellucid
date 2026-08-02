/**
 * Multi-select Dropdown (Popup with tickers)
 *
 * Reusable UI component for selecting multiple items from a list using checkboxes.
 * Designed to match existing dropdown/popup styling in the app (paper box, black border, shadow).
 */

/**
 * @typedef {Object} MultiSelectItem
 * @property {string} key
 * @property {string} label
 */

/**
 * @typedef {Object} MultiSelectDropdownOptions
 * @property {string} id - Unique id prefix for DOM ids
 * @property {string} buttonLabel - Accessible label for the toggle button
 * @property {string} [buttonText='⋯'] - Button text/icon
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
    buttonText = '⋯',
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

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'multi-select-dropdown-btn';
  btn.setAttribute('aria-label', buttonLabel);
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', `${id}-panel`);
  btn.textContent = buttonText;
  wrapper.appendChild(btn);

  const panel = document.createElement('div');
  panel.className = 'multi-select-dropdown-panel';
  panel.id = `${id}-panel`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', title);
  panel.setAttribute('aria-modal', 'true');
  panel.style.display = 'none';
  // Append to body to avoid affecting sidebar scroll position. That places the
  // panel at the very end of the document, so sequential focus would never
  // reach it from the trigger — the panel keeps focus itself while it is open
  // and hands it back to the trigger on close.
  document.body.appendChild(panel);

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
  searchInput.className = 'search-input multi-select-dropdown-search';
  searchInput.placeholder = 'Filter…';
  searchInput.setAttribute('aria-label', `Filter ${title}`);
  searchInput.autocomplete = 'off';
  if (enableSearch) {
    panel.appendChild(searchInput);
  }

  const list = document.createElement('div');
  list.className = 'multi-select-dropdown-list';
  list.style.maxHeight = `${Math.max(120, maxListHeight)}px`;
  panel.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'multi-select-dropdown-actions';
  panel.appendChild(actions);

  const hideAllBtn = document.createElement('button');
  hideAllBtn.type = 'button';
  hideAllBtn.className = 'btn-small';
  hideAllBtn.textContent = 'Hide All';
  actions.appendChild(hideAllBtn);

  const showAllBtn = document.createElement('button');
  showAllBtn.type = 'button';
  showAllBtn.className = 'btn-small';
  showAllBtn.textContent = 'Show All';
  actions.appendChild(showAllBtn);

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn-small';
  applyBtn.textContent = 'Apply';
  actions.appendChild(applyBtn);

  const updateMeta = () => {
    metaEl.textContent = `${pendingSelected.size}/${currentItems.length}`;
    btn.title = `${title} (${committedSelected.size} selected)`;
  };

  const renderList = () => {
    const q = enableSearch ? (searchInput.value || '').trim().toLowerCase() : '';
    list.innerHTML = '';

    const filtered = q
      ? currentItems.filter(it =>
        (it.label || it.key).toLowerCase().includes(q) ||
        it.key.toLowerCase().includes(q)
      )
      : currentItems;

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'multi-select-dropdown-empty';
      empty.textContent = 'No matches';
      list.appendChild(empty);
      updateMeta();
      return;
    }

    for (const it of filtered) {
      const row = document.createElement('label');
      row.className = 'multi-select-dropdown-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = pendingSelected.has(it.key);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) pendingSelected.add(it.key);
        else pendingSelected.delete(it.key);
        updateMeta();
      });

      const labelText = it.label || it.key;
      const labelEl = document.createElement('span');
      labelEl.className = 'multi-select-dropdown-label';
      labelEl.textContent = labelText;
      labelEl.title = labelText;

      row.appendChild(checkbox);
      row.appendChild(labelEl);
      list.appendChild(row);
    }

    updateMeta();
  };

  let isOpen = false;
  let openAbortController = null;

  /** Every element inside the panel a keyboard user can land on, in order. */
  const getPanelFocusables = () => [
    ...panel.querySelectorAll(
      'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ].filter(element => !element.disabled);

  const close = ({ restoreFocus = true } = {}) => {
    if (!isOpen) return;
    isOpen = false;

    if (openAbortController) {
      openAbortController.abort();
      openAbortController = null;
    }

    // Move focus out before hiding: a focused element inside a `display: none`
    // subtree is dropped to `<body>`, which loses the user's place entirely.
    const hadFocusInside = panel.contains(document.activeElement);
    panel.style.display = 'none';
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('open');
    panel.classList.remove('open');
    if (restoreFocus && hadFocusInside) btn.focus({ preventScroll: true });

    // Reset pending state so next open reflects committed selection.
    pendingSelected = new Set(committedSelected);
    if (enableSearch) searchInput.value = '';
  };

  const updatePanelPosition = () => {
    const btnRect = btn.getBoundingClientRect();
    panel.style.top = `${btnRect.bottom + 4}px`;
    panel.style.left = `${btnRect.left}px`;
  };

  const open = () => {
    if (isOpen) return;
    isOpen = true;

    pendingSelected = new Set(committedSelected);
    if (enableSearch) searchInput.value = '';
    renderList();

    // Position panel using fixed positioning relative to the button
    panel.style.display = 'block';
    updatePanelPosition();

    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('open');
    panel.classList.add('open');

    openAbortController = new AbortController();
    const { signal } = openAbortController;

    // Close on Escape, and keep Tab inside the panel while it is open.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = getPanelFocusables();
      if (focusables.length === 0) return;
      // Move focus explicitly rather than letting the engine's own Tab order
      // decide: WebKit omits buttons from sequential focus, so a wrap-only trap
      // lets focus escape the popup entirely there.
      e.preventDefault();
      const current = focusables.indexOf(document.activeElement);
      const step = e.shiftKey ? -1 : 1;
      const next = current < 0
        ? (e.shiftKey ? focusables.length - 1 : 0)
        : (current + step + focusables.length) % focusables.length;
      focusables[next].focus();
    }, { signal });

    // Close on click outside
    document.addEventListener('mousedown', (e) => {
      if (!wrapper.contains(e.target) && !panel.contains(e.target)) {
        close({ restoreFocus: false });
      }
    }, { signal });

    // Update position on scroll (capture to catch scrolls from any ancestor)
    document.addEventListener('scroll', updatePanelPosition, { signal, capture: true });

    // The panel lives at the end of <body>, so nothing would carry focus into
    // it. Start on the filter box, or the first control when there is none.
    const initialFocus = enableSearch ? searchInput : getPanelFocusables()[0];
    initialFocus?.focus({ preventScroll: true });
  };

  const toggle = () => {
    if (isOpen) close();
    else open();
  };

  // A native <button> already turns Enter and Space into a click, and Escape is
  // owned by the document listener installed while the panel is open, so the
  // trigger needs no key handling of its own.
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
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

export default {
  createMultiSelectDropdown
};
