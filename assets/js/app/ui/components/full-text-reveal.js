/**
 * @fileoverview The whole text of a row cut to one line, on a click or a tap.
 *
 * The sidebar keeps one line per row and cuts what does not fit with "…"
 * (owner, 2026-11-10, bug hunt F8). Hover shows the whole text (`title`), but
 * a touch screen has no hover: an element marked `data-full-text` whose text
 * is cut shows it in a small popover on a click or a tap, and nothing when
 * it fits. The mark is opt-in: an element whose single click already means
 * something (a button, a menu) is not marked, its row opening the full text
 * its own way.
 *
 * The attribute's value, when not empty, is the text to show (an element
 * whose shown text is shorter than what it stands for); empty, the
 * element's own text. A second click on the same element, a click elsewhere,
 * Escape, scrolling or resizing closes it.
 *
 * @module ui/components/full-text-reveal
 */

import { computeInfoPopoverPosition } from './info-popovers.js';

const SELECTOR = '[data-full-text]';

/** Whether an element's text is cut by its box (one line with an ellipsis). */
export function isTextCut(element) {
  return element.scrollWidth > element.clientWidth + 1;
}

/** The text an element marked `data-full-text` stands for. */
export function fullTextOf(element) {
  const given = element.getAttribute('data-full-text');
  return given !== null && given !== '' ? given : (element.textContent ?? '').trim();
}

/**
 * Install the reveal on a document: one delegated listener for every marked
 * element, now and later.
 *
 * @param {{root: Document}} options
 * @returns {{destroy: () => void}}
 */
export function initFullTextReveal({ root }) {
  const view = root.defaultView;
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  let popover = null;
  let owner = null;

  function close() {
    popover?.remove();
    popover = null;
    owner = null;
  }

  function open(element) {
    close();
    popover = root.createElement('div');
    popover.className = 'full-text-popover';
    popover.setAttribute('role', 'tooltip');
    popover.textContent = fullTextOf(element);
    // Inside an open modal the popover belongs to it (the top layer).
    (element.closest('dialog[open]') ?? root.body).appendChild(popover);
    const position = computeInfoPopoverPosition({
      triggerRect: element.getBoundingClientRect(),
      popoverRect: popover.getBoundingClientRect(),
      viewportWidth: view.innerWidth,
      viewportHeight: view.innerHeight,
    });
    popover.style.left = `${position.left}px`;
    popover.style.top = `${position.top}px`;
    owner = element;
  }

  root.addEventListener('click', event => {
    const target = event.target instanceof view.Element ? event.target : null;
    const element = target?.closest(SELECTOR) ?? null;
    if (element === null) {
      if (popover !== null && !popover.contains(target)) close();
      return;
    }
    if (element === owner) {
      close();
      return;
    }
    if (isTextCut(element)) open(element);
    else close();
  }, { signal });
  // In the capture phase: a dialog keeps its keys from the page
  // (`app-dialog.js`), and a popover shown inside one closes on Escape too.
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && popover !== null) close();
  }, { signal, capture: true });
  for (const type of ['scroll', 'resize']) {
    view.addEventListener(type, () => { if (popover !== null) close(); }, { signal, capture: true, passive: true });
  }

  return {
    destroy() {
      lifecycle.abort();
      close();
    },
  };
}
