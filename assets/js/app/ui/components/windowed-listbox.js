/**
 * @fileoverview The listbox of a search combobox, windowed over any number of
 * entries. The sidebar's gene search and the analysis gene selector both list
 * every gene that matches, so both use this one list.
 *
 * Every entry is listed, and only the options near what is shown are built:
 * entries [windowStart, windowEnd), a page at a time as the list is scrolled
 * or arrowed, between two spacers that stand for the entries not built at one
 * row each. The list scrolls over every entry, and a list of tens of
 * thousands of entries opens, jumps to its end (End) or wraps (ArrowUp) as
 * fast as one of a hundred: End on 8,192 entries builds one page, and arrowing
 * touches two rows.
 *
 * The list follows the ARIA combobox/listbox pattern: focus stays in the
 * input, the active entry is announced through `aria-activedescendant`, and
 * each built option carries its position in the whole list
 * (`aria-posinset`/`aria-setsize`), since most of the list is not built.
 * The active entry has the `active` class; which entry is the chosen value
 * (`selected`) and what choosing does are the caller's.
 *
 * @module ui/components/windowed-listbox
 */

/** Entries built at a time, when the list opens, scrolls or is arrowed. */
const PAGE_ENTRIES = 100;
/** Built entries beyond this many pages are dropped from the far side. */
const BUILT_PAGES = 4;
/** Row height assumed until the first built option has been laid out. */
const ESTIMATED_ROW_HEIGHT = 24;

/**
 * @param {object} options
 * @param {HTMLInputElement} options.input - The combobox input.
 * @param {HTMLElement} options.listbox - The scrolling list element.
 * @param {string} options.idPrefix - Option ids are `${idPrefix}-${index}`.
 * @param {(index: number) => HTMLElement} options.buildOption - Builds the
 *   option of entry `index` (its text, classes and data); the list adds its
 *   id, role, ARIA position and active state.
 * @param {((index: number) => void)|null} [options.onActive] - Called with an
 *   entry each time it becomes active (prefetch on intent).
 * @param {AbortSignal} [options.signal] - Removes the list's listeners when
 *   the owner is torn down; a list living as long as its elements needs none.
 */
export function createWindowedListbox({
  input,
  listbox,
  idPrefix,
  buildOption,
  onActive = null,
  signal = undefined,
}) {
  if (typeof idPrefix !== 'string' || idPrefix.length === 0) {
    throw new TypeError('Windowed listbox requires a non-empty option id prefix.');
  }
  if (typeof buildOption !== 'function') {
    throw new TypeError('Windowed listbox requires buildOption(index).');
  }
  if (onActive !== null && typeof onActive !== 'function') {
    throw new TypeError('Windowed listbox onActive must be a function or null.');
  }
  const ownerDocument = listbox.ownerDocument;

  let count = 0;
  let activeIndex = -1;
  let windowStart = 0;
  let windowEnd = 0;
  let rowHeight = 0;
  /** The built options, in entry order: entries [windowStart, windowEnd). */
  let nodes = [];
  const topSpacer = createSpacer();
  const bottomSpacer = createSpacer();

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  listbox.setAttribute('role', 'listbox');

  function createSpacer() {
    const spacer = ownerDocument.createElement('div');
    spacer.className = 'dropdown-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.height = '0px';
    return spacer;
  }

  /** One built option's height, measured once one is laid out. */
  function readRowHeight() {
    if (rowHeight > 0) return rowHeight;
    const height = nodes[0]?.offsetHeight;
    if (Number.isFinite(height) && height > 0) {
      rowHeight = height;
      return rowHeight;
    }
    return ESTIMATED_ROW_HEIGHT;
  }

  function updateSpacers() {
    const height = readRowHeight();
    topSpacer.style.height = `${windowStart * height}px`;
    bottomSpacer.style.height = `${(count - windowEnd) * height}px`;
  }

  /** The built option of entry `index`, or null when it is not built. */
  function optionAt(index) {
    if (index < windowStart || index >= windowEnd) return null;
    return nodes[index - windowStart];
  }

  function markActive(option, active) {
    option.classList[active ? 'add' : 'remove']('active');
    option.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  /** Build the options of entries [start, end) and insert them before `before`. */
  function insertOptions(start, end, before) {
    const fragment = ownerDocument.createDocumentFragment();
    const built = [];
    for (let index = start; index < end; index++) {
      const option = buildOption(index);
      option.setAttribute('id', `${idPrefix}-${index}`);
      option.setAttribute('role', 'option');
      option.setAttribute('aria-posinset', String(index + 1));
      option.setAttribute('aria-setsize', String(count));
      markActive(option, index === activeIndex);
      built.push(option);
      fragment.appendChild(option);
    }
    listbox.insertBefore(fragment, before);
    return built;
  }

  /**
   * Build the entries [start, end): the built range grows when they touch it
   * (and drops its far side past BUILT_PAGES pages), and is replaced when
   * they do not.
   */
  function showRange(requestedStart, requestedEnd) {
    const start = Math.max(0, requestedStart);
    const end = Math.min(count, requestedEnd);
    if (end <= start || (start >= windowStart && end <= windowEnd)) return;
    const builtLimit = BUILT_PAGES * PAGE_ENTRIES;
    if (windowEnd > windowStart && start <= windowEnd && end >= windowStart) {
      if (end > windowEnd) {
        nodes.push(...insertOptions(windowEnd, end, bottomSpacer));
        windowEnd = end;
        const excess = windowEnd - windowStart - builtLimit;
        if (excess > 0) {
          for (const node of nodes.splice(0, excess)) node.remove();
          windowStart += excess;
        }
      }
      if (start < windowStart) {
        nodes.unshift(...insertOptions(start, windowStart, nodes[0] ?? bottomSpacer));
        windowStart = start;
        const excess = windowEnd - windowStart - builtLimit;
        if (excess > 0) {
          for (const node of nodes.splice(nodes.length - excess)) node.remove();
          windowEnd -= excess;
        }
      }
    } else {
      for (const node of nodes) node.remove();
      nodes = insertOptions(start, end, bottomSpacer);
      windowStart = start;
      windowEnd = end;
    }
    updateSpacers();
  }

  /** Scroll the list (only the list) so `option` is in view. */
  function scrollIntoList(option) {
    if (
      typeof option.getBoundingClientRect !== 'function'
      || typeof listbox.getBoundingClientRect !== 'function'
    ) {
      return;
    }
    const box = listbox.getBoundingClientRect();
    const top = box.top + (listbox.clientTop || 0);
    const bottom = top + listbox.clientHeight;
    const row = option.getBoundingClientRect();
    if (row.top < top) listbox.scrollTop -= top - row.top;
    else if (row.bottom > bottom) listbox.scrollTop += row.bottom - bottom;
  }

  /**
   * Make entry `index` active (-1: none), building the page that reaches it
   * first: the next one when it adjoins the built ones (arrowing), its own
   * page otherwise (End, Home, wrapping).
   *
   * @param {number} index
   */
  function setActive(index) {
    const next = count === 0 ? -1 : Math.max(-1, Math.min(index, count - 1));
    if (next >= windowEnd) {
      showRange(
        Math.max(windowEnd, next + 1 - PAGE_ENTRIES),
        Math.max(next + 1, windowEnd + PAGE_ENTRIES)
      );
    } else if (next >= 0 && next < windowStart) {
      showRange(
        Math.min(next, windowStart - PAGE_ENTRIES),
        Math.min(windowStart, next + PAGE_ENTRIES)
      );
    }
    const previous = optionAt(activeIndex);
    if (previous !== null) markActive(previous, false);
    activeIndex = next;
    const active = optionAt(next);
    if (active === null) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    markActive(active, true);
    input.setAttribute('aria-activedescendant', active.getAttribute('id'));
    scrollIntoList(active);
    onActive?.(next);
  }

  /**
   * List `entryCount` entries from the top, none active; the first page is
   * built.
   *
   * @param {number} entryCount
   */
  function reset(entryCount) {
    if (!Number.isSafeInteger(entryCount) || entryCount < 0) {
      throw new TypeError('Windowed listbox entry count must be a non-negative safe integer.');
    }
    count = entryCount;
    activeIndex = -1;
    windowStart = 0;
    windowEnd = 0;
    nodes = [];
    // A new list starts at the top; a list left scrolled from an earlier,
    // longer one would otherwise build its next page unasked.
    listbox.scrollTop = 0;
    input.removeAttribute('aria-activedescendant');
    if (count === 0) {
      listbox.replaceChildren();
      return;
    }
    listbox.replaceChildren(topSpacer, bottomSpacer);
    showRange(0, PAGE_ENTRIES);
  }

  /**
   * List nothing and show `node` (an empty-state message) instead.
   *
   * @param {Node} node
   */
  function showMessage(node) {
    reset(0);
    listbox.replaceChildren(node);
  }

  /**
   * The navigation keys, the same in every list. ArrowDown/ArrowUp move the
   * active entry and wrap at either end; with none active they start at the
   * first or the last entry. On a closed list they open it (`open`), and move
   * only when opening left no entry active. Home and End jump to the first and
   * the last entry of an open list.
   *
   * @param {KeyboardEvent} event
   * @param {{ isOpen: () => boolean, open: () => void }} owner
   * @returns {boolean} Whether the key was handled.
   */
  function handleKeydown(event, { isOpen, open }) {
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen()) {
        open();
        if (activeIndex >= 0) return true;
      }
      if (count === 0) return true;
      const step = key === 'ArrowDown' ? 1 : -1;
      setActive(activeIndex < 0
        ? (step > 0 ? 0 : count - 1)
        : (activeIndex + step + count) % count);
      return true;
    }
    if ((key === 'Home' || key === 'End') && isOpen() && count > 0) {
      event.preventDefault();
      setActive(key === 'Home' ? 0 : count - 1);
      return true;
    }
    return false;
  }

  // Scrolling builds the entries that come into view: the next or previous
  // page near the built ones' ends, or a new range where a dragged scroll bar
  // lands.
  listbox.addEventListener('scroll', () => {
    if (count === 0) return;
    const measured = rowHeight > 0;
    const height = readRowHeight();
    // Built while hidden, the spacers held an estimate; now it is measured.
    if (!measured && rowHeight > 0) updateSpacers();
    const first = Math.floor(listbox.scrollTop / height);
    const last = Math.ceil((listbox.scrollTop + listbox.clientHeight) / height);
    if (last + 2 >= windowEnd && windowEnd < count) {
      showRange(first, last + PAGE_ENTRIES);
    } else if (first - 2 <= windowStart && windowStart > 0) {
      showRange(first - PAGE_ENTRIES, last);
    }
  }, { signal });

  return {
    reset,
    showMessage,
    setActive,
    handleKeydown,
    getActiveIndex: () => activeIndex,
    getCount: () => count,
  };
}
