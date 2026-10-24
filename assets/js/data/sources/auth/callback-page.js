/**
 * The page Microsoft's sign-in returns to (`assets/auth/callback.html`). It
 * hands the authorization code and `state` to the Cellucid tab that opened
 * the sign-in, over a `BroadcastChannel` (Microsoft's pages may cut a popup
 * off from its opener), removes them from its own address, and closes. It
 * keeps nothing, loads nothing else, and redeems nothing: the opener alone
 * holds the verifier the code is redeemed with.
 *
 * @module data/sources/auth/callback-page
 */

import { SIGN_IN_CHANNEL } from './microsoft.js';

/**
 * The message a callback address carries, or null: `{state, code}` or
 * `{state, error, errorDescription}`.
 *
 * @param {string} hash - The address's fragment (`#code=…&state=…`)
 * @returns {Object|null}
 */
export function callbackMessage(hash) {
  const fields = new URLSearchParams(String(hash).replace(/^#/, ''));
  const state = fields.get('state');
  if (state === null) return null;
  const code = fields.get('code');
  if (code !== null) return { state, code };
  return { state, error: fields.get('error') ?? 'unknown', errorDescription: fields.get('error_description') ?? '' };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const message = callbackMessage(window.location.hash);
  history.replaceState(null, '', window.location.pathname);
  const status = document.getElementById('status');
  if (message === null) {
    if (status) status.textContent = 'There is no sign-in to finish here. You can close this window.';
  } else {
    const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
    channel.postMessage(message);
    channel.close();
    if (status) status.textContent = 'Signed in. You can close this window.';
    window.close();
  }
}
