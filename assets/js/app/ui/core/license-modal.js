/**
 * License modal wiring (loaded from `index.html`).
 *
 * Requirements:
 * - Must never throw (page should still load even if DOM changes).
 * - Minimal, dependency-free DOM bindings.
 *
 * `index.html` loads this file as a classic script, so it cannot import the
 * shared dialog helpers. The focus contract below is the one
 * `assets/js/app/ui/modules/figure-export/components/modal.js` implements:
 * initial focus inside the dialog, Tab moved by index so the cycle does not
 * depend on an engine's native tab order, Escape closes, focus returned to the
 * element that opened it.
 *
 * Expected DOM:
 * - `#license-modal` containing `.license-backdrop`, `.license-content` and
 *   `.license-body`
 * - `#license-link` anchor/button that opens the modal
 * - `#license-close-btn` button that closes the modal
 */
(() => {
  const modal = document.getElementById('license-modal');
  const link = document.getElementById('license-link');
  const closeBtn = document.getElementById('license-close-btn');
  const backdrop = modal ? modal.querySelector('.license-backdrop') : null;
  const content = modal ? modal.querySelector('.license-content') : null;
  const body = modal ? modal.querySelector('.license-body') : null;

  if (!modal || !link || !closeBtn || !backdrop || !content || !body) return;

  const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[tabindex]',
    '[contenteditable="true"]'
  ].join(',');

  // The licence text scrolls. Chromium makes such a container a tab stop on its
  // own; Firefox and WebKit do not. Declaring it keeps the scroll region
  // reachable by keyboard in every engine and inside the Tab cycle below.
  body.setAttribute('tabindex', '0');

  /** @type {HTMLElement|null} */
  let returnFocus = null;

  const isOpen = () => !modal.classList.contains('hidden');

  const listFocusable = () =>
    Array.from(content.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (element) => (
        element instanceof HTMLElement &&
        element.tabIndex >= 0 &&
        element.getAttribute('aria-hidden') !== 'true' &&
        !('disabled' in element && element.disabled) &&
        element.getClientRects().length > 0
      )
    );

  /**
   * Keep Tab inside the dialog. `aria-modal="true"` tells assistive technology
   * the rest of the document is inert, so keyboard focus must not leave either.
   * @param {KeyboardEvent} event
   */
  const containFocus = (event) => {
    if (event.key !== 'Tab' || !isOpen()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const focusables = listFocusable();
    if (focusables.length === 0) return;
    const activeIndex = focusables.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? (activeIndex <= 0 ? focusables.length - 1 : activeIndex - 1)
      : (
          activeIndex < 0 || activeIndex === focusables.length - 1
            ? 0
            : activeIndex + 1
        );
    focusables[nextIndex].focus();
  };

  /** @param {Event=} event */
  const openModal = (event) => {
    try {
      event?.preventDefault?.();
    } catch {
      // ignore
    }
    // The link is the only opener, and a mouse click does not focus an anchor
    // in every engine, so the invoker is named rather than sampled from
    // `document.activeElement`.
    returnFocus = link;
    modal.classList.remove('hidden');
    try {
      document.body.style.overflow = 'hidden';
    } catch {
      // ignore
    }
    closeBtn.focus();
  };

  const closeModal = () => {
    modal.classList.add('hidden');
    try {
      document.body.style.overflow = '';
    } catch {
      // ignore
    }
    const target = returnFocus;
    returnFocus = null;
    if (target === null || !target.isConnected) return;
    if (target instanceof HTMLButtonElement && target.disabled) return;
    target.focus();
  };

  link.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', containFocus, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });
})();
