/**
 * @fileoverview Welcome modal onboarding logic.
 * @module ui/onboarding/welcome-modal
 */

import { welcomeQuotes } from './quotes.js';

let welcomeModal = null;
let welcomeCallbacks = { onExplore: null };
let welcomeListenersAttached = false;

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
  welcomeModal.classList.remove('hidden');
  return true;
}

export function hideWelcomeModal() {
  if (welcomeModal) welcomeModal.classList.add('hidden');
}

export function isWelcomeModalVisible() {
  return Boolean(welcomeModal && !welcomeModal.classList.contains('hidden'));
}

export function shouldShowWelcome() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('remote') || params.get('github') || params.get('dataset') || params.get('jupyter')) {
    return false;
  }
  return true;
}

