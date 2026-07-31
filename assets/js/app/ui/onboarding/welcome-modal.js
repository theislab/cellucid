/**
 * @fileoverview Welcome modal onboarding logic.
 * @module ui/onboarding/welcome-modal
 */

import { welcomeQuotes } from './quotes.js';

/**
 * Focusable descendants, matching `ui/modules/figure-export/components/modal.js`.
 * That dialog moves focus by index on every Tab instead of only at the ends of
 * the cycle, which is what keeps the cycle correct in engines whose native tab
 * order differs from this list — WebKit skips links, so a boundary-only trap
 * leaks focus straight out of the dialog there.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[tabindex]',
  '[contenteditable="true"]'
].join(',');

let welcomeModal = null;
let welcomeCallbacks = { onExplore: null };
let welcomeListenersAttached = false;
/** Element that owned focus when the modal opened, restored when it closes. */
let welcomeReturnFocus = null;

function setRandomQuote() {
  const quoteEl = welcomeModal?.querySelector('.welcome-quote-text');
  const authorEl = welcomeModal?.querySelector('.welcome-quote-author');
  const bookEl = welcomeModal?.querySelector('.welcome-quote-book');
  const explanationEl = welcomeModal?.querySelector('.welcome-quote-explanation');
  if (!quoteEl || welcomeQuotes.length === 0) return;

  // Avoid showing the same quote twice in a row.
  let lastIndex = -1;
  try {
    lastIndex = parseInt(localStorage.getItem('cellucid_last_quote_index') || '-1', 10);
  } catch {
    // localStorage unavailable
  }

  let newIndex;
  do {
    newIndex = Math.floor(Math.random() * welcomeQuotes.length);
  } while (newIndex === lastIndex && welcomeQuotes.length > 1);

  try {
    localStorage.setItem('cellucid_last_quote_index', String(newIndex));
  } catch {
    // localStorage unavailable
  }

  const quote = welcomeQuotes[newIndex];
  quoteEl.textContent = `"${quote.text}"`;
  if (authorEl) authorEl.textContent = quote.author;
  if (bookEl) bookEl.textContent = quote.book;
  if (explanationEl) explanationEl.textContent = quote.explanation;
}

function welcomeDialogRoot() {
  return welcomeModal?.querySelector('.welcome-content') ?? null;
}

function listWelcomeFocusable() {
  const root = welcomeDialogRoot();
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (element) => (
      element instanceof HTMLElement &&
      element.tabIndex >= 0 &&
      element.getAttribute('aria-hidden') !== 'true' &&
      !('disabled' in element && element.disabled) &&
      element.getClientRects().length > 0
    )
  );
}

/**
 * Keep Tab inside the dialog. `aria-modal="true"` tells assistive technology
 * the rest of the document is inert, so keyboard focus must not leave either.
 */
function containWelcomeFocus(e) {
  if (e.key !== 'Tab' || !isWelcomeModalVisible()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const focusables = listWelcomeFocusable();
  if (focusables.length === 0) return;
  const activeIndex = focusables.indexOf(document.activeElement);
  const nextIndex = e.shiftKey
    ? (activeIndex <= 0 ? focusables.length - 1 : activeIndex - 1)
    : (
        activeIndex < 0 || activeIndex === focusables.length - 1
          ? 0
          : activeIndex + 1
      );
  focusables[nextIndex].focus();
}

function captureWelcomeReturnFocus() {
  const previous = document.activeElement;
  welcomeReturnFocus =
    previous instanceof HTMLElement &&
    previous !== document.body &&
    !welcomeModal.contains(previous)
      ? previous
      : null;
}

function restoreWelcomeReturnFocus() {
  const target = welcomeReturnFocus;
  welcomeReturnFocus = null;
  if (target === null || !target.isConnected) return;
  if (target instanceof HTMLButtonElement && target.disabled) return;
  target.focus();
}

export function initWelcomeModal(callbacks = {}) {
  welcomeModal = document.getElementById('welcome-modal');
  if (!welcomeModal) return;

  welcomeCallbacks = { ...welcomeCallbacks, ...callbacks };

  if (!welcomeListenersAttached) {
    welcomeListenersAttached = true;

    const exploreBtn = document.getElementById('welcome-demo-btn');
    const backdrop = welcomeModal.querySelector('.welcome-backdrop');

    if (exploreBtn) {
      exploreBtn.addEventListener('click', () => {
        hideWelcomeModal();
        if (welcomeCallbacks.onExplore) welcomeCallbacks.onExplore();
      });
    }

    if (backdrop) {
      backdrop.addEventListener('click', () => hideWelcomeModal());
    }

    document.addEventListener('keydown', containWelcomeFocus, true);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isWelcomeModalVisible()) {
        hideWelcomeModal();
      }
    });
  }

  setRandomQuote();
}

export function showWelcomeModal() {
  if (!welcomeModal) return false;
  captureWelcomeReturnFocus();
  welcomeModal.classList.remove('hidden');
  const focusables = listWelcomeFocusable();
  if (focusables.length === 0) {
    throw new Error(
      'Welcome modal must expose at least one focusable control to receive focus.'
    );
  }
  focusables[0].focus();
  return true;
}

export function hideWelcomeModal() {
  if (!welcomeModal) return;
  welcomeModal.classList.add('hidden');
  restoreWelcomeReturnFocus();
}

export function isWelcomeModalVisible() {
  return Boolean(welcomeModal && !welcomeModal.classList.contains('hidden'));
}
