/**
 * Microsoft sign-in for OneDrive and SharePoint, with no server and no
 * third-party library: the authorization code flow with PKCE for a
 * single-page application, in a popup.
 *
 * 1. The button's click opens the popup, empty and of this site, inside the
 *    click; this page then makes the attempt's PKCE verifier and sends the
 *    popup to Microsoft's sign-in page (the `common` authority: personal and
 *    work or school accounts). Opened straight at Microsoft's address, the
 *    popup would be Safari's to hand to a Mac's single sign-on extension
 *    (Microsoft's, which an organisation's Company Portal installs): Safari
 *    then signs in with the Mac's work account in a window nobody sees,
 *    renders Microsoft's answer there ("Need admin approval") and closes it,
 *    before any page of Cellucid's is reached. A popup opened on this site
 *    and then sent to Microsoft is an ordinary window: Microsoft's sign-in
 *    page, for any account.
 * 2. Microsoft sends the popup back to `assets/auth/callback.html`, which
 *    posts the code and `state` on a `BroadcastChannel` (a channel, because
 *    Microsoft's pages may cut the popup off from its opener). This page
 *    answers that it received them, and the popup then closes. A popup found
 *    closed before that offers the step again, and this page keeps listening
 *    until the step ends: a popup cut off from this page reads as closed
 *    while the person still signs in there, and its message still counts.
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
import { createPkce } from './pkce.js';
import { finalSignInFailure, getSignInSteps } from './sign-in.js';
import { readSignInRecord, removeSignIn, setSignInExpiry, writeSignInRecord } from './token-store.js';

export const GRAPH = 'https://graph.microsoft.com';
export const FILES_READ = `${GRAPH}/Files.Read`;
export const FILES_READ_ALL = `${GRAPH}/Files.Read.All`;
export const CALLBACK_PATH = '/assets/auth/callback.html';
export const SIGN_IN_CHANNEL = 'cellucid-sign-in';
/** The sign-in window: one, which a second click brings back and sends to Microsoft again. */
const SIGN_IN_WINDOW = 'cellucid-microsoft-sign-in';
const SIGN_IN_WINDOW_FEATURES = 'popup=yes,width=520,height=680';
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

/** Where a work or school account's administrator reads how to approve Cellucid. */
export const MICROSOFT_ADMIN_HELP = Object.freeze({
  url: 'https://docs.cellucid.com/en/latest/user_guide/web_app/b_data_loading/16_private_drive_onedrive.html#work-and-school-accounts-administrator-approval',
  label: 'How an administrator approves Cellucid',
});

/** The next attempt's button when the same account would only fail again. */
const OTHER_ACCOUNT = 'Use another account';

/** Microsoft Entra's sign-in errors (`AADSTS<n>`), by what they leave the person to do. */
const ADMIN_APPROVAL_CODES = new Set([90094, 90095, 90099, 65001]);
const NOT_ASSIGNED_CODES = new Set([50105]);
const POLICY_CODES = new Set([53000, 53001, 53002, 53003, 530032, 50097]);
const SITE_CODES = new Set([50011, 50194, 70001, 70011, 700016, 700054, 500113, 9002326, 9002331, 7000218]);
const TRANSIENT_CODES = new Set([90033, 50196, 50058]);

/** The organisation Microsoft names in its answer ("An administrator of <name> has set a policy …"), or null. */
function organisationOf(description) {
  const named = /administrator of (.+?) (?:has|have) /i.exec(String(description ?? ''));
  return named === null ? null : named[1].trim();
}

function failure(message, code, { final = false, retryAction = null, help = null, prompt = null } = {}) {
  const error = new MicrosoftSignInError(message, code);
  if (retryAction !== null) error.retryAction = retryAction;
  if (help !== null) error.help = help;
  // How the next sign-in asks Microsoft (`prompt`): another account to choose.
  if (prompt !== null) error.prompt = prompt;
  return final ? finalSignInFailure(error) : error;
}

/**
 * What an error answer of Microsoft's sign-in means, for the person, and
 * what is offered next. `error` is the OAuth error (`access_denied`,
 * `invalid_request`, …), `description` Microsoft's text, which names the
 * `AADSTS<n>` code, and `subcode` its `error_subcode` (`cancel`).
 *
 * Returning from Microsoft's "Need admin approval" page without granting
 * comes back as a decline (`access_denied`, `cancel`, AADSTS65004), the same
 * answer as a person who declined, so that message names both.
 *
 * @param {string|null} error
 * @param {string} [description]
 * @param {string|null} [subcode]
 * @returns {MicrosoftSignInError}
 */
export function describeMicrosoftError(error, description = '', subcode = null) {
  const code = Number(/AADSTS(\d+)/.exec(`${error ?? ''} ${description ?? ''}`)?.[1] ?? NaN);
  const organisation = organisationOf(description);
  const yours = organisation === null ? 'Your organisation' : `Your organisation (${organisation})`;
  if (ADMIN_APPROVAL_CODES.has(code)) {
    return failure(
      `${yours} lets only an administrator approve Cellucid. Ask your IT administrator to approve it ` +
      '(the Cellucid documentation, "Work and school accounts: administrator approval", says how), or ' +
      'sign in with a personal Microsoft account.' +
      (code === 90095 ? ' If you sent Microsoft\'s approval request, sign in again once it is approved.' : ''),
      'ADMIN_APPROVAL',
      { retryAction: OTHER_ACCOUNT, help: MICROSOFT_ADMIN_HELP, prompt: 'select_account' }
    );
  }
  if (NOT_ASSIGNED_CODES.has(code)) {
    return failure(
      `${yours} lets only the people it assigned use Cellucid, and this account is not one of them. Ask your ` +
      'IT administrator to assign you, or sign in with a personal Microsoft account.',
      'NOT_ASSIGNED',
      { retryAction: OTHER_ACCOUNT, help: MICROSOFT_ADMIN_HELP, prompt: 'select_account' }
    );
  }
  if (POLICY_CODES.has(code)) {
    return failure(
      `${yours}'s sign-in policy does not let this browser or device sign in to Cellucid. Ask your IT ` +
      'administrator, or sign in with a personal Microsoft account.',
      'POLICY',
      { retryAction: OTHER_ACCOUNT, help: MICROSOFT_ADMIN_HELP, prompt: 'select_account' }
    );
  }
  if (SITE_CODES.has(code) || error === 'unauthorized_client' || error === 'invalid_client') {
    return failure(
      `Microsoft does not accept this site's sign-in (${Number.isFinite(code) ? `AADSTS${code}` : error}). The ` +
      'problem is the site\'s, not your account\'s: open Cellucid at www.cellucid.com.',
      'NOT_AVAILABLE',
      { final: true }
    );
  }
  if (code === 65004 || error === 'access_denied' || subcode === 'cancel') {
    return failure(
      'Microsoft sign-in ended without Cellucid\'s permission. If you declined it, sign in again and accept. ' +
      'If Microsoft said "Need admin approval", your organisation lets only an administrator approve ' +
      'Cellucid: ask your IT administrator (the Cellucid documentation, "Work and school accounts: ' +
      'administrator approval", says how), or sign in with a personal Microsoft account.',
      'DECLINED',
      { retryAction: 'Sign in again', help: MICROSOFT_ADMIN_HELP, prompt: 'select_account' }
    );
  }
  if (TRANSIENT_CODES.has(code) || error === 'temporarily_unavailable' || error === 'server_error') {
    return failure(`Microsoft could not finish the sign-in just now (${Number.isFinite(code) ? `AADSTS${code}` : error}). Try again.`, 'FAILED');
  }
  return failure(`Microsoft sign-in did not finish (${Number.isFinite(code) ? `AADSTS${code}` : error}).`, 'FAILED');
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
  /** How the next sign-in asks Microsoft: to choose an account, after one that cannot sign in. */
  let nextPrompt = null;

  const authority = () => config.authority || 'common';
  const redirectUri = () => `${win.location.origin}${CALLBACK_PATH}`;

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
      throw describeMicrosoftError(answer?.error ?? `HTTP ${response.status}`, answer?.error_description ?? '', answer?.error_subcode ?? null);
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

  /** Microsoft's sign-in address for one attempt. */
  function authorizeUrl(more, pkce) {
    const url = new URL(`https://login.microsoftonline.com/${authority()}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      response_mode: 'fragment',
      redirect_uri: redirectUri(),
      scope: scopesFor(more),
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state: pkce.state,
      ...(nextPrompt === null ? {} : { prompt: nextPrompt }),
    }).toString();
    return url.href;
  }

  /**
   * One attempt, from the step's button: the popup opens inside the click,
   * empty and of this site, before anything is awaited, then goes to
   * Microsoft; the code its return page posts is redeemed here. The attempt
   * listens until the step ends (`signal`); a popup found closed is
   * reported, and the step offered again, without ending it.
   *
   * @param {boolean} more
   * @param {import('./sign-in.js').SignInAttempt} attempt
   */
  function popupSignIn(more, { signal, report }) {
    const popup = win.open('', SIGN_IN_WINDOW, SIGN_IN_WINDOW_FEATURES);
    // A pop-up blocker answers with no window, or with one already closed.
    if (popup === null || popup === undefined || popup.closed === true) {
      return Promise.reject(new MicrosoftSignInError(
        'The browser blocked Microsoft\'s sign-in window. Allow pop-ups for this site, then click the button again.',
        'POPUP_BLOCKED'
      ));
    }
    // The window of an earlier attempt, still open, comes to the front.
    popup.focus?.();
    return createPkce().then(pkce => new Promise((resolve, reject) => {
      const { state } = pkce;
      const channel = new win.BroadcastChannel(SIGN_IN_CHANNEL);
      let watch = null;
      const stop = () => {
        clearInterval(watch);
        channel.close();
        signal.removeEventListener('abort', ended);
      };
      const ended = () => {
        stop();
        reject(signal.reason);
      };
      const settle = token => {
        nextPrompt = null;
        resolve(token);
      };
      const fail = error => {
        stop();
        // An account that cannot sign in: the next attempt chooses one.
        nextPrompt = typeof error?.prompt === 'string' ? error.prompt : nextPrompt;
        reject(error);
      };
      // The step ended while the verifier was made: the window has nothing to show.
      if (signal.aborted) {
        popup.close();
        ended();
        return;
      }
      signal.addEventListener('abort', ended, { once: true });
      channel.onmessage = event => {
        const message = event.data;
        if (message?.state !== state || message.received === true) return;
        channel.postMessage({ state, received: true });
        stop();
        if (typeof message.code !== 'string') {
          fail(describeMicrosoftError(message.error, message.errorDescription, message.errorSubcode ?? null));
          return;
        }
        tokenRequest({
          grant_type: 'authorization_code',
          code: message.code,
          redirect_uri: redirectUri(),
          code_verifier: pkce.verifier,
          scope: scopesFor(more),
        }).then(({ answer, askedAt }) => settle(adopt(answer, askedAt)), fail);
      };
      // The window closes only after this page answers its message, so a
      // window found closed before that most likely brought no sign-in; one
      // that did after all is still heard (the channel stays open).
      watch = setInterval(() => {
        if (popup.closed !== true) return;
        clearInterval(watch);
        report(new MicrosoftSignInError(closedText(), 'POPUP_CLOSED'));
      }, POPUP_WATCH_MS);
      popup.location.replace(authorizeUrl(more, pkce));
    }));
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
      act: attempt => popupSignIn(more, attempt),
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
