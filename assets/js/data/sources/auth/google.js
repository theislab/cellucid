/**
 * Google sign-in for Google Drive, with no server: Google Identity Services'
 * token model (`initTokenClient`) and the Google Picker, both Google's own
 * scripts, loaded only when a Drive file needs them.
 *
 * Cellucid asks for one scope, `drive.file`: access to the files the person
 * chooses for Cellucid in Google's file picker, and to nothing else. A pasted
 * private link opens the picker already showing that one file
 * (`DocsView.setFileIds`), so one click on Select grants it. Google states
 * the scope as "see, edit, create and delete only the specific Google Drive
 * files you use with this app": no read-only form of it exists, and Cellucid
 * only ever reads.
 *
 * The access token (about an hour) is kept for the tab in the shared sign-in
 * store (`token-store.js`). A token cannot be renewed without a click (the
 * token model has no refresh token), so an expired one shows the calm "Sign
 * in again" step and the reads waiting on it resume after the click.
 *
 * @module data/sources/auth/google
 */

import { PROVIDER_CONFIG } from '../provider-config.js';
import { embeddingOrigin, isLocalOrigin, pageOrigin } from './page-context.js';
import { finalSignInFailure, getSignInSteps } from './sign-in.js';
import { readSignInRecord, removeSignIn, setSignInExpiry, writeSignInRecord } from './token-store.js';
import { whileWaitingOnPerson } from '../../../utils/person-wait.js';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
export const GAPI_SCRIPT_URL = 'https://apis.google.com/js/api.js';
const STORE_NAME = 'google';

function validRecord(record) {
  return typeof record.accessToken === 'string' && record.accessToken !== '' &&
    Number.isFinite(record.expiresAt) && typeof record.scope === 'string';
}

/** A refusal the person reads, with a code the UI and tests can name. */
export class GoogleSignInError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GoogleSignInError';
    this.code = code;
  }
}

/** Where a Google Workspace administrator reads how to allow Cellucid. */
export const GOOGLE_ADMIN_HELP = Object.freeze({
  url: 'https://docs.cellucid.com/en/latest/user_guide/web_app/b_data_loading/16_private_drive_onedrive.html#google-workspace-accounts-administrator-approval',
  label: 'How an administrator allows Cellucid',
});

function signInFailure(message, code, { final = false, retryAction = null, help = null, prompt = null } = {}) {
  const error = new GoogleSignInError(message, code);
  if (retryAction !== null) error.retryAction = retryAction;
  if (help !== null) error.help = help;
  // How the next sign-in asks Google (`prompt`): another account to choose.
  if (prompt !== null) error.prompt = prompt;
  return final ? finalSignInFailure(error) : error;
}

/**
 * What an error of Google's sign-in means, for the person, and what is
 * offered next: the OAuth error of a token answer (`access_denied`,
 * `admin_policy_enforced`, …), or the type of a window that did not finish
 * (`popup_closed`, `popup_failed_to_open`). Google shows "Access blocked"
 * (its administrator's policy) in its own window, which the person may
 * close instead: that comes back as a closed window, so its message names
 * both.
 *
 * @param {string} error
 * @returns {GoogleSignInError}
 */
export function describeGoogleError(error) {
  switch (error) {
    case 'access_denied':
      return signInFailure(
        'You declined Cellucid\'s request to read the Google Drive files you choose for it. Sign in again and allow it.',
        'DECLINED',
        { retryAction: 'Sign in again' }
      );
    case 'admin_policy_enforced':
      return signInFailure(
        'Your Google Workspace administrator does not allow Cellucid for this account. Ask them to allow it ' +
        '(the Cellucid documentation, "Google Workspace accounts: administrator approval", says how), or sign ' +
        'in with a personal Google account.',
        'ADMIN_POLICY',
        { retryAction: 'Use another account', help: GOOGLE_ADMIN_HELP, prompt: 'select_account' }
      );
    case 'org_internal':
    case 'invalid_client':
    case 'unauthorized_client':
    case 'redirect_uri_mismatch':
    case 'origin_mismatch':
      return signInFailure(
        `Google does not accept this site's sign-in (${error}). The problem is the site's, not your account's: ` +
        'open Cellucid at www.cellucid.com.',
        'NOT_AVAILABLE',
        { final: true }
      );
    case 'popup_failed_to_open':
      return signInFailure(
        'The browser blocked Google\'s sign-in window. Allow pop-ups for this site and try again.',
        'POPUP_BLOCKED'
      );
    case 'popup_closed':
      return signInFailure(
        'Google\'s sign-in window was closed before it finished. If Google said "Access blocked", your ' +
        'organisation\'s administrator does not allow Cellucid: sign in with a personal Google account, or ask ' +
        'them (the Cellucid documentation, "Google Workspace accounts: administrator approval", says how).',
        'POPUP_CLOSED',
        { help: GOOGLE_ADMIN_HELP }
      );
    default:
      return signInFailure(`Google sign-in did not finish (${error}).`, 'DECLINED');
  }
}

/**
 * @param {{config?: Object, steps?: import('./sign-in.js').SignInSteps, win?: Object, now?: () => number}} [options]
 */
export function createGoogleAuth({
  config = PROVIDER_CONFIG.google,
  steps = getSignInSteps(),
  win = globalThis,
  now = () => Date.now(),
} = {}) {
  let session = readSignInRecord(STORE_NAME, validRecord);
  // The token model has no refresh token: the sign-in ends with its token.
  setSignInExpiry(STORE_NAME, session?.expiresAt ?? null, now);
  let scripts = null;
  let tokenClient = null;
  let pendingToken = null;
  /** How the next sign-in asks Google: '' (as Google decides), or to choose an account after one that cannot sign in. */
  let nextPrompt = '';

  /**
   * Why Google refuses this page's origin, or null. The API key's website
   * restriction and the client ID's JavaScript origins list the same
   * registered origins, matched exactly, port included: a public file and a
   * sign-in work on the same pages.
   */
  function whyNotThisOrigin() {
    const here = pageOrigin(win);
    if (config.registeredOrigins.includes(here)) return null;
    if (!isLocalOrigin(here)) return `Google Drive works on www.cellucid.com, not on ${here}.`;
    // A notebook widget frames the app from its web_source_url (by default
    // www.cellucid.com, a registered origin); `cellucid serve` opens in a tab
    // of its own.
    return embeddingOrigin(win) === null
      ? `Google Drive works on a local cellucid serve only on its default port, 8765 (this page is ${here}). ` +
        'Start it without --port, or open www.cellucid.com.'
      : `Google Drive works in a notebook viewer that loads the app from www.cellucid.com (the default web_source_url), ` +
        `or from a copy served at port 8765; this one loads it from ${here}.`;
  }

  /** Why public Drive files cannot be read on this page, or null. */
  function whyNoPublicAccess() {
    if (!config.apiKey) return 'Google Drive is not configured on this site yet.';
    return whyNotThisOrigin();
  }

  /** Why this page cannot sign in to Google, or null. */
  function whyNoSignIn() {
    if (!config.clientId || !config.apiKey || !config.projectNumber) {
      return 'Signing in to Google is not configured on this site yet.';
    }
    return whyNotThisOrigin();
  }

  function loadScript(url) {
    const documentRef = win.document;
    return new Promise((resolve, reject) => {
      const script = documentRef.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new GoogleSignInError(
        'Google\'s sign-in could not be loaded: the network or a browser extension blocked accounts.google.com or apis.google.com.',
        'SCRIPT_BLOCKED'
      ));
      documentRef.head.appendChild(script);
    });
  }

  /** Load Google's sign-in and Picker scripts once; nothing of Google loads before. */
  function loadScripts() {
    scripts ??= (async () => {
      const loads = [];
      if (win.google?.accounts?.oauth2 === undefined) loads.push(loadScript(GIS_SCRIPT_URL));
      if (win.gapi === undefined) loads.push(loadScript(GAPI_SCRIPT_URL));
      await Promise.all(loads);
      if (win.google?.picker === undefined) {
        await new Promise((resolve, reject) => win.gapi.load('picker', {
          callback: resolve,
          onerror: () => reject(new GoogleSignInError('Google\'s file picker could not be loaded.', 'SCRIPT_BLOCKED')),
        }));
      }
    })();
    scripts.catch(() => {
      scripts = null;
    });
    return scripts;
  }

  /** The stored token while it has not expired, else null. */
  function validToken() {
    if (session === null) return null;
    if (now() >= session.expiresAt) return null;
    return session.accessToken;
  }

  function adopt(response, askedAt) {
    if (typeof response?.access_token !== 'string' || !Number.isFinite(Number(response.expires_in))) {
      throw new GoogleSignInError('Google did not return a sign-in.', 'NO_TOKEN');
    }
    if (!String(response.scope ?? '').split(' ').includes(DRIVE_FILE_SCOPE)) {
      throw new GoogleSignInError(
        'Google did not grant access to the files you choose for Cellucid. Sign in again and allow it.',
        'SCOPE_DENIED'
      );
    }
    // Counted from when the token was asked for: it cannot have been issued earlier.
    session = {
      accessToken: response.access_token,
      expiresAt: askedAt + Number(response.expires_in) * 1000,
      scope: String(response.scope),
    };
    writeSignInRecord(STORE_NAME, session);
    setSignInExpiry(STORE_NAME, session.expiresAt, now);
    return session.accessToken;
  }

  /**
   * Ask Google for a token. Must run inside a click: GIS opens its popup at
   * once. The popup closes by itself when consent was given before.
   */
  function requestToken() {
    if (pendingToken !== null) return pendingToken;
    const oauth2 = win.google.accounts.oauth2;
    const askedAt = now();
    pendingToken = new Promise((resolve, reject) => {
      tokenClient ??= oauth2.initTokenClient({
        client_id: config.clientId,
        scope: DRIVE_FILE_SCOPE,
        prompt: '',
        callback: () => {},
      });
      const fail = error => {
        // An account that cannot sign in: the next attempt chooses one.
        nextPrompt = typeof error?.prompt === 'string' ? error.prompt : nextPrompt;
        reject(error);
      };
      tokenClient.callback = response => {
        if (response?.error) {
          fail(describeGoogleError(String(response.error)));
          return;
        }
        try {
          resolve(adopt(response, askedAt));
          nextPrompt = '';
        } catch (error) {
          fail(error);
        }
      };
      tokenClient.error_callback = error => fail(describeGoogleError(
        error?.type === 'popup_failed_to_open' ? 'popup_failed_to_open' : 'popup_closed'
      ));
      tokenClient.requestAccessToken({ prompt: nextPrompt });
    }).finally(() => {
      pendingToken = null;
    });
    return pendingToken;
  }

  /**
   * A valid token: the stored one, or one the person signs in for through
   * the step `kind` (`sign-in` or `expired`).
   *
   * @param {{kind?: string, text?: string, signal?: AbortSignal|null}} [options]
   * @returns {Promise<string>}
   */
  async function authorize({ kind = 'sign-in', text = 'Sign in to Google to open this file.', signal = null } = {}) {
    const token = validToken();
    if (token !== null) return token;
    const refusal = whyNoSignIn();
    if (refusal !== null) throw new GoogleSignInError(refusal, 'NOT_AVAILABLE');
    return steps.request({
      account: 'google',
      kind,
      text,
      action: kind === 'expired' ? 'Sign in again' : 'Sign in to Google',
      ready: loadScripts(),
      act: () => requestToken(),
      signal,
    });
  }

  /**
   * Open Google's file picker on one file; resolves with the id the person
   * selected. Granting it to Cellucid is Google's part of the click. The
   * picker is a wait on the person (`utils/person-wait.js`).
   *
   * @param {string} fileId
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<string>}
   */
  async function pick(fileId, { signal = null } = {}) {
    await loadScripts();
    const token = validToken();
    if (token === null) throw new GoogleSignInError('Google sign-in expired.', 'EXPIRED');
    const pickerApi = win.google.picker;
    return whileWaitingOnPerson(new Promise((resolve, reject) => {
      const view = new pickerApi.DocsView(pickerApi.ViewId.DOCS)
        .setFileIds(fileId)
        .setMode(pickerApi.DocsViewMode.LIST);
      let picker = null;
      const onAbort = () => {
        picker?.setVisible(false);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      picker = new pickerApi.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(config.apiKey)
        .setAppId(config.projectNumber)
        .setTitle('Choose the file to open in Cellucid')
        .setCallback(data => {
          const action = data?.[pickerApi.Response.ACTION];
          if (action === pickerApi.Action.PICKED) {
            signal?.removeEventListener('abort', onAbort);
            const picked = data[pickerApi.Response.DOCUMENTS]?.[0]?.[pickerApi.Document.ID] ?? null;
            if (picked === null) reject(new GoogleSignInError('Google\'s file picker returned no file.', 'NOT_PICKED'));
            else resolve(picked);
          } else if (action === pickerApi.Action.CANCEL) {
            signal?.removeEventListener('abort', onAbort);
            reject(new GoogleSignInError(
              'Google\'s file picker was closed without choosing the file, so Cellucid cannot read it. ' +
              'If the picker showed no file, your Google account has no access to it: ask its owner to share it with you.',
              'NOT_PICKED'
            ));
          }
        })
        .build();
      picker.setVisible(true);
    }));
  }

  /** Forget the sign-in, and revoke the token at Google. */
  function signOut() {
    const token = session?.accessToken ?? null;
    session = null;
    try {
      removeSignIn(STORE_NAME);
    } catch {
      // Nothing stored that could be read back either.
    }
    if (token !== null) win.google?.accounts?.oauth2?.revoke?.(token, () => {});
  }

  /** Signed in now (a token that has not expired). */
  function signedIn() {
    return validToken() !== null;
  }

  /** The token Google refused (HTTP 401): it is forgotten, and the next read asks again. */
  function refused(token) {
    if (session?.accessToken === token) {
      session = null;
      try {
        removeSignIn(STORE_NAME);
      } catch {
        // as above
      }
    }
  }

  return Object.freeze({
    whyNoPublicAccess,
    whyNoSignIn,
    loadScripts,
    validToken,
    authorize,
    pick,
    signOut,
    signedIn,
    refused,
    get apiKey() {
      return config.apiKey;
    },
  });
}

let google = null;

/** The page's Google sign-in. */
export function getGoogleAuth() {
  google ??= createGoogleAuth();
  return google;
}
