/**
 * @fileoverview Defer sidebar rendering while its panel cannot be seen.
 *
 * Several sidebar lists re-render on every visibility frame (filter chips,
 * legend counts, highlighted groups). While their panel is collapsed, or the
 * whole sidebar is hidden, that work produces nothing anyone can see. A gated
 * render runs immediately when its element is shown, and otherwise marks
 * itself dirty and runs once when the element is shown again.
 *
 * "Shown" means: no ancestor `<details>` is closed, and the element is not
 * inside a hidden `#sidebar`. A panel undocked into a floating window keeps
 * its `<details>`, so the same gate follows it.
 *
 * @module ui/core/visibility-gate
 */

const SIDEBAR_ID = 'sidebar';

/** One observer of the sidebar's `hidden` class, shared by every gate. */
const sidebarListeners = new Set();
let sidebarObserver = null;

function watchSidebar(ownerDocument, listener) {
  sidebarListeners.add(listener);
  if (sidebarObserver === null) {
    const sidebar = ownerDocument.getElementById(SIDEBAR_ID);
    const View = ownerDocument.defaultView;
    if (sidebar !== null && typeof View?.MutationObserver === 'function') {
      sidebarObserver = new View.MutationObserver(() => {
        for (const notify of [...sidebarListeners]) notify();
      });
      sidebarObserver.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    }
  }
  return () => {
    sidebarListeners.delete(listener);
    if (sidebarListeners.size === 0 && sidebarObserver !== null) {
      sidebarObserver.disconnect();
      sidebarObserver = null;
    }
  };
}

/**
 * Whether `element` is in a panel the user can currently see.
 *
 * @param {Element} element
 * @returns {boolean}
 */
export function isPanelShown(element) {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    if (node.localName === 'details' && !node.open) return false;
    if (node.id === SIDEBAR_ID && node.classList.contains('hidden')) return false;
  }
  return true;
}

/**
 * Wrap `render` so it runs only while `element` is shown.
 *
 * @template {unknown[]} A
 * @param {Element} element - The element the render draws into.
 * @param {(...args: A) => void} render
 * @returns {{ request: (...args: A) => void, destroy: () => void }}
 */
export function createVisibilityGatedRender(element, render) {
  if (element === null || typeof element !== 'object' || typeof element.closest !== 'function') {
    throw new TypeError('A gated render requires its target element');
  }
  if (typeof render !== 'function') {
    throw new TypeError('A gated render requires its render function');
  }
  const ownerDocument = element.ownerDocument;
  const controller = new AbortController();
  let pending = null;

  const runIfShown = () => {
    if (pending === null || !isPanelShown(element)) return;
    const args = pending;
    pending = null;
    render(...args);
  };

  // The `<details>` that contain the element never change, even when its
  // panel floats; `toggle` does not bubble, so each one is listened to.
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    if (node.localName === 'details') {
      node.addEventListener('toggle', runIfShown, { signal: controller.signal });
    }
  }
  const unwatch = watchSidebar(ownerDocument, runIfShown);

  return {
    request(...args) {
      pending = args;
      runIfShown();
    },
    destroy() {
      controller.abort();
      unwatch();
      pending = null;
    }
  };
}
