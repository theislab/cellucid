/**
 * @fileoverview The welcome dialog shown at an ordinary start.
 *
 * An app dialog (`ui/components/app-dialog.js`): Start exploring (its
 * `data-dialog-close`), Escape and the backdrop close it, and focus goes back
 * where it was. It opens with focus on the dialog itself, so no choice looks
 * pre-selected; the first Tab reaches the first choice.
 *
 * @module ui/onboarding/welcome-modal
 */

import { welcomeQuotes } from './quotes.js';
import { wireAppDialog } from '../components/app-dialog.js';
import { holdStartupFor } from '../../../utils/startup-sequence.js';
import { webStorage } from '../../../utils/web-storage.js';

/** @type {HTMLDialogElement|null} */
let welcomeModal = null;
/** @type {ReturnType<typeof wireAppDialog>|null} */
let welcomeDialog = null;

function setRandomQuote() {
  const quoteEl = welcomeModal?.querySelector('.welcome-quote-text');
  const authorEl = welcomeModal?.querySelector('.welcome-quote-author');
  const bookEl = welcomeModal?.querySelector('.welcome-quote-book');
  const explanationEl = welcomeModal?.querySelector('.welcome-quote-explanation');
  if (!quoteEl || welcomeQuotes.length === 0) return;

  // Avoid showing the same quote twice in a row.
  let lastIndex = -1;
  try {
    lastIndex = parseInt(webStorage('localStorage')?.getItem('cellucid_last_quote_index') || '-1', 10);
  } catch {
    // localStorage unavailable
  }

  let newIndex;
  do {
    newIndex = Math.floor(Math.random() * welcomeQuotes.length);
  } while (newIndex === lastIndex && welcomeQuotes.length > 1);

  try {
    webStorage('localStorage')?.setItem('cellucid_last_quote_index', String(newIndex));
  } catch {
    // localStorage unavailable
  }

  const quote = welcomeQuotes[newIndex];
  quoteEl.textContent = `"${quote.text}"`;
  if (authorEl) authorEl.textContent = quote.author;
  if (bookEl) bookEl.textContent = quote.book;
  if (explanationEl) explanationEl.textContent = quote.explanation;
}

export function initWelcomeModal() {
  welcomeModal = document.getElementById('welcome-modal');
  if (!welcomeModal) return;
  welcomeDialog ??= wireAppDialog(welcomeModal);
  setRandomQuote();
}

/**
 * Show the welcome; the start holds what else it shows until it is closed
 * (`utils/startup-sequence.js`: Continue, a sample view's notices, an
 * opening's question come after it, never on top of it).
 */
export function showWelcomeModal() {
  if (welcomeDialog === null) return false;
  const dialog = welcomeModal;
  holdStartupFor(new Promise(resolve => dialog.addEventListener('close', () => resolve(), { once: true })));
  welcomeDialog.open(null, { focus: welcomeModal });
  return true;
}

export function hideWelcomeModal() {
  welcomeDialog?.close();
}

export function isWelcomeModalVisible() {
  return welcomeModal?.open === true;
}
