/**
 * Microsoft sign-in for OneDrive and SharePoint, with no server and no
 * third-party library: the authorization code flow with PKCE for a
 * single-page application, in a popup.
 *
 * 1. The button's click opens Microsoft's sign-in page in a popup (the
 *    `common` authority: personal and work or school accounts).
 * 2. Microsoft sends the popup back to `assets/auth/callback.html`, which
 *    posts the code and `state` on a `BroadcastChannel` (a channel, because
 *    Microsoft's pages may cut the popup off from its opener). This page
 *    answers that it received them, and the popup then closes; a popup that
 *    closes before that ends the sign-in attempt, which the step offers again.
 * 3. This page redeems the code with the verifier it kept in memory: a
 *    single-page application needs no client secret, and none exists.
 *
 * A channel reaches only pages that share storage. A page embedded in another
 * site (a notebook's viewer) has storage of its own, so the popup's message
 * never reaches it: Cellucid says so before opening the popup when it can
 * tell, and when the popup closes otherwise. Microsoft accepts plain `http://`
 * only for this computer's own addresses, and the browser computes PKCE only
 * on a secure page, so a plain `http://` page on another host is refused
 * first.
 *
 * Cellucid asks for `Files.Read` first: enough for personal accounts and the
 * files shared with them, and for a work account's own files. Reading a file
 * a colleague shared needs `Files.Read.All`, asked for only then; in most
 * organisations an administrator approves that once for everyone.
 *
 * The access token (about an hour) and the refresh token (24 hours for a
 * single-page application, Microsoft's rule) are kept for the tab in the
 * shared sign-in store; a token is renewed without a click until the refresh
 * token ends, then the calm "Sign in again" step asks for one.
 *
 * @module data/sources/auth/microsoft
 */

import { PROVIDER_CONFIG } from '../provider-config.js';
import { embeddedInOtherSite, embeddingOrigin, pageOrigin } from './page-context.js';
import { createPkce, randomUrlSafe } from './pkce.js';
import { finalSignInFailure, getSignInSteps } from './sign-in.js';
import { readSignInRecord, removeSignIn, setSignInExpiry, writeSignInRecord } from './token-store.js';

export const GRAPH = 'https://graph.microsoft.com';
export const FILES_READ = `${GRAPH}/Files.Read`;
export const FILES_READ_ALL = `${GRAPH}/Files.Read.All`;
export const CALLBACK_PATH = '/assets/auth/callback.html';
export const SIGN_IN_CHANNEL = 'cellucid-sign-in';
/** How often the page looks whether the sign-in window is still open. */
const POPUP_WATCH_MS = 500;
/** A single-page application's refresh token lasts 24 hours and is not extended (Microsoft's rule). */
const SPA_REFRESH_LIFETIME_MS = 24 * 60 * 60 * 1000;
const STORE_NAME = 'microsoft';

function validRecord(record) {
  return typeof record.accessToken === 'string' && record.accessToken !== '' &&
    Number.isFinite(record.expiresAt) && typeof record.scope === 'string' &&
    (record.refreshToken === null || typeof record.refreshToken === 'string') &&
    Number.isFinite(record.refreshExpiresAt);
}

/**
 * When a sign-in ends: its access token, or the 24 hours its refresh token
 * renews it for, whichever is later. Null for no sign-in.
 */
function signedInUntil(session) {
  if (session === null) return null;
  return session.refreshToken === null
    ? session.expiresAt
    : Math.max(session.expiresAt, session.refreshExpiresAt);
}

/** A refusal the person reads, with a code the UI and tests can name. */
export class MicrosoftSignInError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MicrosoftSignInError';
    this.code = code;
  }
}

/** Whether a granted scope list holds `scope` (Microsoft may answer short names). */
export function grantsScope(granted, scope) {
  const short = scope.replace(`${GRAPH}/`, '').toLowerCase();
  return String(granted).split(/\s+/).some(item => {
    const name = item.toLowerCase();
    return name === scope.toLowerCase() || name === short;
  });
}

/** What an error answer of Microsoft's sign-in means, for the person. */
export function describeMicrosoftError(error, description = '') {
  const text = `${error ?? ''} ${description ?? ''}`;
  if (/AADSTS(90094|90095|65001)/.test(text) || /admin/i.test(String(description)) && /consent/i.test(text)) {
    return finalSignInFailure(new MicrosoftSignInError(
      'Your organisation must approve Cellucid before it can read files shared with you. ' +
      'Ask your IT administrator to approve Cellucid once for your organisation.',
      'ADMIN_APPROVAL'
    ));
  }
  if (error === 'access_denied' || /AADSTS65004/.test(text)) {
    return new MicrosoftSignInError('Microsoft sign-in was declined.', 'DECLINED');
  }
  return new MicrosoftSignInError(`Microsoft sign-in did not finish (${error}).`, 'FAILED');
}

/**
 * @param {{config?: Object, steps?: import('./sign-in.js').SignInSteps, win?: Object,
 *   fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createMicrosoftAuth({
  config = PROVIDER_CONFIG.microsoft,
  steps = getSignInSteps(),
  win = globalThis,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let session = readSignInRecord(STORE_NAME, validRecord);
  setSignInExpiry(STORE_NAME, signedInUntil(session), now);
  let renewing = null;
  /** A verifier and challenge made ahead, so the click opens the popup at once. */
  let nextPkce = null;
  let pkceReady = null;

  const authority = () => config.authority || 'common';
  const redirectUri = () => `${win.location.origin}${CALLBACK_PATH}`;

  function preparePkce() {
    pkceReady = createPkce().then(pair => {
      nextPkce = pair;
    });
    return pkceReady;
  }

  /** Why this page cannot sign in to Microsoft, or null. */
  function whyNoSignIn() {
    if (!config.clientId) return 'Signing in to Microsoft is not configured on this site yet.';
    if (win.isSecureContext === false) {
      return `Microsoft sign-in needs https:// or this computer's own address (localhost), not ${pageOrigin(win)}. ` +
        'Open www.cellucid.com.';
    }
    if (embeddedInOtherSite(win) === true) {
      return `Microsoft sign-in cannot reach Cellucid inside another site's page (${embeddingOrigin(win)}). ` +
        'Open Cellucid in its own tab, such as www.cellucid.com.';
    }
    return null;
  }

  /** What the person reads when the sign-in window closed without a sign-in. */
  function closedText() {
    const text = 'Microsoft\'s sign-in window was closed before it finished.';
    return embeddingOrigin(win) === null
      ? text
      : `${text} If you signed in, the browser kept the sign-in from this embedded page: open Cellucid in its own tab.`;
  }

  function adopt(answer, askedAt, previous = null) {
    if (typeof answer?.access_token !== 'string' || !Number.isFinite(Number(answer.expires_in))) {
      throw new MicrosoftSignInError('Microsoft did not return a sign-in.', 'NO_TOKEN');
    }
    session = {
      accessToken: answer.access_token,
      expiresAt: askedAt + Number(answer.expires_in) * 1000,
      scope: String(answer.scope ?? ''),
      refreshToken: typeof answer.refresh_token === 'string' ? answer.refresh_token : null,
      // A renewal keeps the first sign-in's end: the 24 hours are not extended.
      refreshExpiresAt: previous?.refreshExpiresAt ?? askedAt + SPA_REFRESH_LIFETIME_MS,
    };
    writeSignInRecord(STORE_NAME, session);
    setSignInExpiry(STORE_NAME, signedInUntil(session), now);
    return session.accessToken;
  }

  async function tokenRequest(fields) {
    const askedAt = now();
    let response;
    try {
      response = await fetchImpl(`https://login.microsoftonline.com/${authority()}/oauth2/v2.0/token`, {
        method: 'POST',
        // A form body is a simple request: no preflight.
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, ...fields }).toString(),
      });
    } catch {
      throw new MicrosoftSignInError('Microsoft\'s sign-in service could not be reached.', 'NETWORK');
    }
    let answer = null;
    try {
      answer = await response.json();
    } catch {
      answer = null;
    }
    if (!response.ok) {
      throw describeMicrosoftError(answer?.error ?? `HTTP ${response.status}`, answer?.error_description ?? '');
    }
    return { answer, askedAt };
  }

  function scopesFor(more) {
    return ['openid', 'offline_access', FILES_READ, ...(more ? [FILES_READ_ALL] : [])].join(' ');
  }

  /** Whether the stored sign-in grants the read of colleagues' files. */
  function hasWideAccess() {
    return session !== null && grantsScope(session.scope, FILES_READ_ALL);
  }

  /**
   * A valid access token without asking the person: the stored one, or one
   * renewed with the refresh token (one renewal for every caller at once).
   *
   * @param {{more?: boolean}} [options] - `more`: `Files.Read.All` is needed
   * @returns {Promise<string|null>}
   */
  async function silentToken({ more = false } = {}) {
    if (session === null) return null;
    if (more && !hasWideAccess()) return null;
    if (now() < session.expiresAt) return session.accessToken;
    if (session.refreshToken === null || now() >= session.refreshExpiresAt) return null;
    renewing ??= (async () => {
      const previous = session;
      try {
        const { answer, askedAt } = await tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: previous.refreshToken,
          scope: scopesFor(grantsScope(previous.scope, FILES_READ_ALL)),
        });
        return adopt(answer, askedAt, previous);
      } catch {
        return null;
      }
    })().finally(() => {
      renewing = null;
    });
    return renewing;
  }

  /**
   * Open the sign-in popup and redeem its code. Runs inside a click: the
   * popup opens before the first `await`.
   */
  function popupSignIn(more) {
    if (nextPkce === null) {
      return Promise.reject(new MicrosoftSignInError('Microsoft sign-in is getting ready; try again.', 'NOT_READY'));
    }
    const pkce = nextPkce;
    nextPkce = null;
    preparePkce();
    const state = `${pkce.state}.${randomUrlSafe(8)}`;
    const url = new URL(`https://login.microsoftonline.com/${authority()}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      response_mode: 'fragment',
      redirect_uri: redirectUri(),
      scope: scopesFor(more),
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
    }).toString();
    const popup = win.open(url.href, 'cellucid-microsoft-sign-in', 'popup=yes,width=520,height=680');
    if (popup === null || popup === undefined) {
      return Promise.reject(new MicrosoftSignInError(
        'The browser blocked Microsoft\'s sign-in window. Allow pop-ups for this site and try again.',
        'POPUP_BLOCKED'
      ));
    }
    return new Promise((resolve, reject) => {
      const channel = new win.BroadcastChannel(SIGN_IN_CHANNEL);
      // The window closes only after this page answers its message, so a
      // window found closed before that brought no sign-in.
      const watch = setInterval(() => {
        if (popup.closed !== true) return;
        clearInterval(watch);
        channel.close();
        reject(new MicrosoftSignInError(closedText(), 'POPUP_CLOSED'));
      }, POPUP_WATCH_MS);
      channel.onmessage = event => {
        const message = event.data;
        if (message?.state !== state || message.received === true) return;
        clearInterval(watch);
        channel.postMessage({ state, received: true });
        channel.close();
        if (typeof message.code !== 'string') {
          reject(describeMicrosoftError(message.error, message.errorDescription));
          return;
        }
        tokenRequest({
          grant_type: 'authorization_code',
          code: message.code,
          redirect_uri: redirectUri(),
          code_verifier: pkce.verifier,
          scope: scopesFor(more),
        }).then(({ answer, askedAt }) => resolve(adopt(answer, askedAt)), reject);
      };
    });
  }

  /**
   * A valid token: silently when possible, else through the step `kind`
   * (`sign-in`, `expired`, or `more-access` for colleagues' files).
   *
   * @param {{kind?: string, text?: string, more?: boolean, signal?: AbortSignal|null}} [options]
   * @returns {Promise<string>}
   */
  async function authorize({ kind = 'sign-in', text = 'Sign in with Microsoft to open this file.', more = false, signal = null } = {}) {
    const token = await silentToken({ more });
    if (token !== null) return token;
    const refusal = whyNoSignIn();
    if (refusal !== null) throw new MicrosoftSignInError(refusal, 'NOT_AVAILABLE');
    return steps.request({
      account: 'microsoft',
      kind,
      text,
      action: kind === 'expired' ? 'Sign in again' : kind === 'more-access' ? 'Ask for access' : 'Sign in with Microsoft',
      ready: nextPkce !== null ? null : (pkceReady ?? preparePkce()),
      act: () => popupSignIn(more),
      signal,
    });
  }

  /** The token Microsoft refused (HTTP 401): renewed or asked for again next time. */
  function refused(token) {
    if (session?.accessToken === token) {
      session = { ...session, expiresAt: 0 };
      writeSignInRecord(STORE_NAME, session);
      setSignInExpiry(STORE_NAME, signedInUntil(session), now);
    }
  }

  /** Forget the sign-in in this tab. Cellucid does not sign the person out of Microsoft. */
  function signOut() {
    session = null;
    try {
      removeSignIn(STORE_NAME);
    } catch {
      // Nothing stored that could be read back either.
    }
  }

  return Object.freeze({
    whyNoSignIn,
    silentToken,
    authorize,
    hasWideAccess,
    refused,
    signOut,
    signedIn: () => session !== null && now() < signedInUntil(session),
  });
}

let microsoft = null;

/** The page's Microsoft sign-in. */
export function getMicrosoftAuth() {
  microsoft ??= createMicrosoftAuth();
  return microsoft;
}
