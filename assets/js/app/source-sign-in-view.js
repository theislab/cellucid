/**
 * Shows the sign-in steps a data source waits on (`data/sources/auth/
 * sign-in.js`) in two places, both calm and non-modal:
 *
 * - **One line under the address bar** in the Session panel: "Private file
 *   on Google Drive. [Sign in to Google] (i)". The (i) says what Cellucid
 *   gets, where the data goes, what is kept and how to revoke it.
 * - **A notification with the same button**, for when the panel is closed or
 *   the startup overlay covers the viewer.
 *
 * With no step waiting, the same line says which accounts are signed in in
 * this tab ("Signed in to Google") with **Sign out**, which forgets each
 * sign-in (`token-store.js`, through the account's own sign-out, which also
 * revokes a Google token) and drops every read that used it
 * (`revokeSourceAccess`), so the next read asks again. The line follows the
 * token store (`onSignInChange`): it hides once a sign-in expires, and names
 * one made or renewed elsewhere.
 *
 * The button takes the step inside the click, so a sign-in popup opens. It
 * waits while the provider's script loads (Google's), and a step whose
 * attempt did not finish (a window closed, a pop-up blocked) says why and
 * offers the button again.
 *
 * @module app/source-sign-in-view
 */

import { getSignInSteps } from '../data/sources/auth/sign-in.js';
import { onSignInChange } from '../data/sources/auth/token-store.js';
import { getGoogleAuth } from '../data/sources/auth/google.js';
import { getMicrosoftAuth } from '../data/sources/auth/microsoft.js';
import { revokeSourceAccess } from '../data/sources/access.js';
import { renderInfoTip } from './ui/components/info-tips.js';

/** The (i) tip of each account's step. */
const ACCOUNTS = Object.freeze({
  google: Object.freeze({ tip: 'sign-in-google' }),
  microsoft: Object.freeze({ tip: 'sign-in-microsoft' }),
});

/**
 * The accounts a signed-in line can name: what it is called, its sign-in,
 * the sources that read with it, and its (i).
 */
const SIGNED_IN = Object.freeze([
  Object.freeze({ name: 'Google', auth: () => getGoogleAuth(), providers: ['gdrive'], tip: 'sign-in-google' }),
  Object.freeze({ name: 'Microsoft', auth: () => getMicrosoftAuth(), providers: ['onedrive'], tip: 'sign-in-microsoft' }),
]);

function signedInAccounts() {
  return SIGNED_IN.filter(account => {
    try {
      return account.auth().signedIn();
    } catch {
      return false;
    }
  });
}

function lineText(step) {
  if (step.problem !== null) return `${step.text} ${step.problem}`;
  if (!step.ready) return `${step.text} Getting the sign-in ready…`;
  if (step.working) return `${step.text} Finish signing in in the window that opened.`;
  return step.text;
}

/**
 * Show every sign-in step of the page.
 *
 * @param {{notifications: Object, documentRef?: Document, steps?: import('../data/sources/auth/sign-in.js').SignInSteps}} options
 * @returns {() => void} Stop showing them
 */
export function showSourceSignIn({ notifications, documentRef = document, steps = getSignInSteps() }) {
  const line = documentRef.getElementById('data-sign-in-step');
  const text = documentRef.getElementById('data-sign-in-text');
  const button = documentRef.getElementById('data-sign-in-btn');
  const tooltip = documentRef.getElementById('data-sign-in-info-tooltip');
  const hasLine = line !== null && text !== null && button !== null;
  let shown = null;
  /** The notification each step is shown in, and the words it was shown with. */
  const notices = new Map();

  const onClick = () => {
    if (shown !== null) {
      steps.run(shown.id);
      return;
    }
    // Sign out of every account the line names.
    for (const account of signedInAccounts()) {
      account.auth().signOut();
      for (const provider of account.providers) revokeSourceAccess(provider);
    }
    renderLine(null);
  };
  button?.addEventListener('click', onClick);

  function renderLine(step) {
    if (!hasLine) return;
    if (step === null) {
      const accounts = signedInAccounts();
      line.hidden = accounts.length === 0;
      if (accounts.length === 0) return;
      text.textContent = `Signed in to ${accounts.map(account => account.name).join(' and ')}`;
      button.textContent = 'Sign out';
      button.disabled = false;
      if (tooltip !== null && tooltip.dataset.infoTip !== accounts[0].tip) renderInfoTip(tooltip, accounts[0].tip);
      return;
    }
    line.hidden = false;
    text.textContent = lineText(step);
    button.textContent = step.action;
    button.disabled = !step.ready;
    const tip = ACCOUNTS[step.account]?.tip ?? null;
    if (tooltip !== null && tip !== null && tooltip.dataset.infoTip !== tip) renderInfoTip(tooltip, tip);
  }

  function renderNotices(list) {
    const live = new Set(list.map(step => step.id));
    for (const [id, notice] of notices) {
      if (live.has(id)) continue;
      notices.delete(id);
      if (notifications.hasNotification(notice.id)) notifications.dismiss(notice.id);
    }
    for (const step of list) {
      // Shown once its button works; shown again when an attempt did not finish.
      if (!step.ready || step.working) continue;
      const message = step.problem === null ? step.text : `${step.text} ${step.problem}`;
      const notice = notices.get(step.id);
      if (notice !== undefined && notice.message === message) continue;
      if (notice !== undefined && notifications.hasNotification(notice.id)) notifications.dismiss(notice.id);
      notices.set(step.id, {
        message,
        id: notifications.info(message, {
          category: 'connectivity',
          duration: 0,
          action: { label: step.action, run: () => steps.run(step.id) },
        }),
      });
    }
  }

  const stop = steps.subscribe(list => {
    shown = list.at(-1) ?? null;
    renderLine(shown);
    renderNotices(list);
  });
  // A sign-in that expires, or one stored or removed elsewhere, changes what
  // the line says while no step is waiting.
  const stopSignIns = onSignInChange(() => {
    if (shown === null) renderLine(null);
  });
  const initial = steps.list();
  shown = initial.at(-1) ?? null;
  renderLine(shown);
  renderNotices(initial);

  return () => {
    stop();
    stopSignIns();
    button?.removeEventListener('click', onClick);
    for (const notice of notices.values()) {
      if (notifications.hasNotification(notice.id)) notifications.dismiss(notice.id);
    }
    notices.clear();
  };
}
