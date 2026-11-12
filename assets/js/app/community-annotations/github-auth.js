/**
 * GitHub App OAuth session (via Cloudflare Worker).
 *
 * - Starts OAuth via full-page redirect to `${WORKER_ORIGIN}/auth/login`
 * - Worker redirects back to the app with an expiring token (GitHub's user
 *   tokens with expiration: 8 hours) and its lifetime in the URL fragment;
 *   the refresh token stays in the worker and is not used
 * - Stores the token and when it expires in the tab's `sessionStorage`
 *   through the shared sign-in store (`data/sources/auth/token-store.js`;
 *   never `localStorage`): a reload keeps the sign-in until the token
 *   expires, then it is forgotten
 * - Accepts a token only for a sign-in this tab started: `signIn()` keeps a
 *   random state in the tab's `sessionStorage` and names it in the address
 *   GitHub returns to (`#cellucid_github_state=…`, which the worker keeps);
 *   a callback whose state is not that one is refused, so a link carrying
 *   someone else's token cannot sign this tab in as them (login CSRF)
 * - Sign out revokes the token at GitHub through the worker
 *   (`${WORKER_ORIGIN}/auth/revoke`), then forgets it
 * - Fetches user identity from `${WORKER_ORIGIN}/auth/user`
 *
 * This module is UI-agnostic (no DOM writes).
 */

import { EventEmitter } from '../utils/event-emitter.js';
import { isLocalDevHost } from '../utils/local-dev.js';
import { parseExactJson } from './wire-contract.js';
import {
  onSignInChange,
  readSignIn,
  removeSignIn,
  setSignInExpiry,
  takeSignInPending,
  writeSignIn,
  writeSignInPending,
} from '../../data/sources/auth/token-store.js';
import {
  isCanonicalGitHubAccount,
  isCanonicalGitHubRepositoryFullName,
} from './github-reference.js';
import { requireExactObjectKeys } from '../../utils/exact-record.js';
import { randomHex } from '../../utils/byte-text.js';
import { isCancellation, cancelled, onAbort, requireSignalOrNull } from '../../utils/abort.js';
import {
  AUTH_ERROR_PARAM,
  AUTH_FLAG_PARAM,
  AUTH_TOKEN_EXPIRES_PARAM,
  AUTH_TOKEN_PARAM,
  WORKER_CONTRACT_VERSION,
  WORKER_ENDPOINTS,
  WORKER_SERVICE,
  scrubAuthFragment,
} from './worker-contract.js';
import {
  WORKER_RESPONSE_CUT,
  WORKER_UNREACHABLE,
  defaultWorkerTransport,
  requestWorker,
} from './worker-request.js';

/** The deployed Worker (`wrangler.community-annotations.jsonc`), on its custom domain. */
const DEFAULT_WORKER_ORIGIN = 'https://api.cellucid.com';

/** The sign-in's name in the shared store: `cellucid:github-app-auth:session`. */
const SIGN_IN_NAME = 'github-app';

/**
 * The state of the sign-in this tab started (`signIn`), in the tab's
 * `sessionStorage` until GitHub's answer comes back, and the fragment field
 * that carries it there and back (the worker keeps every field of the
 * return address that is not one of its own).
 */
export const SIGN_IN_STATE_STORAGE_KEY = 'cellucid:github-app-auth:pending';
export const SIGN_IN_STATE_PARAM = 'cellucid_github_state';

/** A new state (128 random bits) for the sign-in this tab starts, kept in the tab's sign-in store. */
function beginSignInState() {
  const state = randomHex(16);
  try {
    writeSignInPending(SIGN_IN_NAME, state);
  } catch (cause) {
    throw storageFailure('keep the state of', cause);
  }
  return state;
}

/** The state of the sign-in this tab started, taken (one answer per sign-in), or null. */
function takeSignInState() {
  return takeSignInPending(SIGN_IN_NAME);
}

/** A fragment (no `#`) without its state field: what is left, and the state when it was there exactly once. */
function takeStateField(hash) {
  const kept = [];
  const states = [];
  for (const segment of hash.split('&')) {
    const [name, value] = [...new URLSearchParams(segment).entries()][0] ?? [null, null];
    if (name === SIGN_IN_STATE_PARAM) states.push(value);
    else kept.push(segment);
  }
  return { hash: kept.join('&'), kept: kept.length, state: states.length === 1 ? states[0] : null };
}

/** The caller stopped a GitHub authentication request: a cancellation naming its address. */
function requestCancelled(url, cause = undefined) {
  const error = cancelled('user', 'GitHub authentication request was canceled.', cause);
  if (url !== null) error.url = url;
  return error;
}

function createAuthSupersededError(cause = undefined) {
  const error = new Error(
    'GitHub authentication request belongs to a superseded session'
  );
  error.code = 'GITHUB_AUTH_SUPERSEDED';
  if (cause !== undefined) error.cause = cause;
  return error;
}

function assertExactHttpOrigin(raw, label) {
  if (
    typeof raw !== 'string' ||
    !raw ||
    /^\s|\s$/.test(raw)
  ) {
    throw new Error(`${label} must be an exact nonblank HTTP(S) origin`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch (cause) {
    const error = new Error(
      `${label} must be an exact nonblank HTTP(S) origin`
    );
    error.cause = cause;
    throw error;
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    raw !== url.origin
  ) {
    throw new Error(`${label} must be an exact nonblank HTTP(S) origin`);
  }
  return raw;
}

function storageFailure(operation, cause) {
  const error = new Error(
    `The tab's sign-in store could not ${operation} the GitHub annotation session`
  );
  error.code = 'GITHUB_AUTH_STORAGE_FAILED';
  error.cause = cause;
  return error;
}

function assertWorkerErrorDocument(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'error') ||
    typeof value.error !== 'string' ||
    !value.error ||
    /^\s|\s$/.test(value.error) ||
    Array.from(value.error).length > 4096
  ) {
    throw new Error(`${label} must contain exactly one exact error string`);
  }
  return value.error;
}

/**
 * The Worker's root document, checked against this client: the service
 * and contract version first, so a Worker of another version is named as
 * such (`GITHUB_WORKER_OUTDATED` for an older one, which its owner must
 * redeploy; a newer one asks for a reload of Cellucid), then the exact
 * route inventory of contract `WORKER_CONTRACT_VERSION`.
 */
function assertWorkerCompatibilityDocument(value, origin) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.status !== 'ok' ||
    value.service !== WORKER_SERVICE ||
    !Number.isSafeInteger(value.contractVersion)
  ) {
    throw createWorkerIncompatibleError(
      origin,
      new Error('The service at the Worker origin does not identify as the Cellucid GitHub Worker')
    );
  }
  if (value.contractVersion < WORKER_CONTRACT_VERSION) {
    const error = new Error(
      `The community-annotation service at ${origin} runs an older version ` +
      `(contract ${value.contractVersion}) than this Cellucid ` +
      `(contract ${WORKER_CONTRACT_VERSION}); its owner must redeploy the Worker. ` +
      'No GitHub token was sent.'
    );
    error.code = 'GITHUB_WORKER_OUTDATED';
    error.origin = origin;
    error.workerContractVersion = value.contractVersion;
    throw error;
  }
  if (value.contractVersion > WORKER_CONTRACT_VERSION) {
    const error = new Error(
      `The community-annotation service at ${origin} runs a newer version ` +
      `(contract ${value.contractVersion}) than this page of Cellucid ` +
      `(contract ${WORKER_CONTRACT_VERSION}). Reload Cellucid to use it. ` +
      'No GitHub token was sent.'
    );
    error.code = 'GITHUB_WORKER_INCOMPATIBLE';
    error.origin = origin;
    error.workerContractVersion = value.contractVersion;
    throw error;
  }
  try {
    requireExactObjectKeys(
      value,
      ['status', 'service', 'contractVersion', 'endpoints'],
      'GitHub worker capability response'
    );
    if (
      !Array.isArray(value.endpoints) ||
      value.endpoints.length !== WORKER_ENDPOINTS.length ||
      value.endpoints.some((endpoint, index) => endpoint !== WORKER_ENDPOINTS[index])
    ) {
      throw new Error('GitHub worker endpoint inventory does not match this Cellucid client');
    }
  } catch (cause) {
    throw createWorkerIncompatibleError(origin, cause);
  }
  return value;
}

function createWorkerIncompatibleError(origin, cause) {
  const error = new Error(
    `The GitHub community annotation service at ${origin} is not compatible ` +
    'with this Cellucid client. No GitHub token was sent and sign-in was not ' +
    'started.\n\nDeploy the current Cellucid Worker, verify its root endpoint ' +
    'inventory, and ensure this site origin is present in ALLOWED_ORIGINS.'
  );
  error.code = 'GITHUB_WORKER_INCOMPATIBLE';
  error.origin = origin;
  error.cause = cause;
  return error;
}

export function getGitHubWorkerOrigin() {
  if (typeof window === 'undefined') return DEFAULT_WORKER_ORIGIN;
  const overrideRaw = window.__CELLUCID_GITHUB_WORKER_ORIGIN__;
  if (overrideRaw === undefined) {
    return DEFAULT_WORKER_ORIGIN;
  }

  let overrideOrigin;
  try {
    overrideOrigin = assertExactHttpOrigin(
      overrideRaw,
      'GitHub worker origin override'
    );
  } catch (cause) {
    const err = new Error('Invalid GitHub worker origin override. Refusing to continue.');
    err.code = 'GITHUB_WORKER_ORIGIN_INVALID';
    err.cause = cause;
    throw err;
  }

  // Dev safety rule:
  // - Local dev may point at any worker origin (for testing).
  // - Non-local builds must use the compiled-in DEFAULT_WORKER_ORIGIN (prevents token exfiltration via misconfig).
  if (!isLocalDevHost() && overrideOrigin !== DEFAULT_WORKER_ORIGIN) {
    const err = new Error(
      `Untrusted GitHub worker origin override: ${overrideOrigin}\n` +
      `Expected: ${DEFAULT_WORKER_ORIGIN}\n\n` +
      'Refusing to use an untrusted auth proxy to prevent token exfiltration.'
    );
    err.code = 'GITHUB_WORKER_ORIGIN_UNTRUSTED';
    err.origin = overrideOrigin;
    throw err;
  }

  return overrideOrigin;
}

function readSessionItem() {
  try {
    return readSignIn(SIGN_IN_NAME);
  } catch (cause) {
    throw storageFailure('read', cause);
  }
}

function writeSessionItem(value) {
  try {
    writeSignIn(SIGN_IN_NAME, value);
    return true;
  } catch (cause) {
    throw storageFailure('write', cause);
  }
}

function removeSessionItem() {
  try {
    removeSignIn(SIGN_IN_NAME);
    return true;
  } catch (cause) {
    throw storageFailure('remove', cause);
  }
}

/**
 * One JSON request to the Worker through the app's one transport
 * (`worker-request.js`: stall timeouts from the measured link, never a total
 * deadline; the request budget the Worker relays; retries of transient
 * answers). A non-2xx answer throws the Worker's `{error}` sentence with its
 * `status`; a request the caller stopped throws a cancellation.
 *
 * @param {string} url
 * @param {{method?: string, headers?: Record<string, string>|null, body?: unknown,
 *   signal?: AbortSignal|null, transport?: object|null}} [options]
 *   `transport`: the Worker transport (tests give a virtual clock); the
 *   origin's own by default
 */
async function fetchJson(url, {
  method = 'GET',
  headers = null,
  body = null,
  signal = null,
  transport = null,
} = {}) {
  const origin = new URL(url).origin;
  let answer;
  try {
    answer = await requestWorker(
      transport ?? defaultWorkerTransport(origin),
      url,
      {
        method,
        headers: headers || undefined,
        body: body != null ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        credentials: 'omit',
      },
      { signal, label: `${method} ${new URL(url).pathname}`, origin }
    );
  } catch (err) {
    if (isCancellation(err) || signal?.aborted) throw requestCancelled(url, err);
    if (err !== null && typeof err === 'object' && err.url === undefined) err.url = url;
    throw err;
  }
  const { response: res, text } = answer;
  let responseJson;
  try {
    if (!text) throw new Error('empty response body');
    responseJson = parseExactJson(text, {
      path: `GitHub annotation endpoint ${url}`,
    });
  } catch (cause) {
    const error = new Error(
      `GitHub annotation endpoint returned invalid JSON: ${cause?.message || cause}`
    );
    error.code = 'GITHUB_AUTH_RESPONSE_INVALID';
    error.status = res.status;
    error.url = url;
    error.cause = cause;
    throw error;
  }
  if (!res.ok) {
    const msg = assertWorkerErrorDocument(
      responseJson,
      `GitHub annotation endpoint ${url} error response`
    );
    const err = new Error(msg);
    err.status = res.status;
    err.url = url;
    throw err;
  }
  return responseJson;
}

function getGitHubLoginUrl(workerOrigin = null) {
  const rawOrigin = workerOrigin === null
    ? getGitHubWorkerOrigin()
    : workerOrigin;
  const origin = assertExactHttpOrigin(rawOrigin, 'GitHub worker origin');
  return `${origin}/auth/login`;
}

export function toGitHubUserKey(user) {
  if (user === null) return null;
  const exactUser = assertStoredGitHubUser(user);
  return `ghid_${exactUser.id}`;
}

function assertStoredGitHubUser(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    throw new Error('Stored GitHub user must be an object');
  }
  if (!Number.isSafeInteger(user.id) || user.id < 1) {
    throw new Error('Stored GitHub user id must be a positive safe integer');
  }
  assertGitHubLogin(user.login, 'Stored GitHub user login');
  if (
    Object.keys(user).length !== 2 ||
    !Object.hasOwn(user, 'id') ||
    !Object.hasOwn(user, 'login')
  ) {
    throw new Error('Stored GitHub user must contain exactly id and login');
  }
  return user;
}

function assertGitHubUserResponse(user) {
  requireExactObjectKeys(user, ['id', 'login'], 'GitHub user endpoint');
  return assertStoredGitHubUser(user);
}

function assertGitHubLogin(login, label) {
  if (
    typeof login !== 'string' ||
    !login ||
    /^\s|\s$/.test(login) ||
    Array.from(login).length > 64 ||
    !isCanonicalGitHubAccount(login)
  ) {
    throw new Error(`${label} must be an exact nonblank string`);
  }
  return login;
}

/**
 * One page of a Worker collection: `{items, nextPage}`, `nextPage` the page
 * after this one or null on the last (the Worker answers one GitHub page per
 * request: Cloudflare Free allows 50 subrequests per request). Items are
 * checked by `projectItem` and must not repeat within the page.
 */
function assertCollectionPage(document, page, label, projectItem, identityOf) {
  requireExactObjectKeys(document, ['items', 'nextPage'], label);
  if (!Array.isArray(document.items)) {
    throw new Error(`${label} items must be an array`);
  }
  if (document.nextPage !== null && document.nextPage !== page + 1) {
    throw new Error(`${label} nextPage must be ${page + 1} or null`);
  }
  const seen = new Set();
  const items = document.items.map((item, index) => {
    const projected = projectItem(item, index);
    for (const key of identityOf(projected)) {
      if (seen.has(key)) throw new Error(`${label} contains duplicate entries`);
      seen.add(key);
    }
    return projected;
  });
  return { items, nextPage: document.nextPage };
}

function projectInstallation(installation, index) {
  requireExactObjectKeys(
    installation,
    ['id', 'account'],
    `GitHub installation ${index}`
  );
  if (!Number.isSafeInteger(installation.id) || installation.id < 1) {
    throw new Error(
      `GitHub installation ${index} id must be a positive safe integer`
    );
  }
  requireExactObjectKeys(
    installation.account,
    ['login'],
    `GitHub installation ${index} account`
  );
  const login = assertGitHubLogin(
    installation.account.login,
    `GitHub installation ${index} account login`
  );
  return { id: installation.id, account: { login } };
}

function assertRepositoryFullName(fullName, label) {
  if (!isCanonicalGitHubRepositoryFullName(fullName)) {
    throw new Error(`${label} must be an exact owner/repository name`);
  }
  return fullName;
}

function projectRepository(repository, index) {
  requireExactObjectKeys(
    repository,
    ['id', 'full_name', 'private'],
    `GitHub installation repository ${index}`
  );
  if (!Number.isSafeInteger(repository.id) || repository.id < 1) {
    throw new Error(
      `GitHub installation repository ${index} id must be a positive safe integer`
    );
  }
  const fullName = assertRepositoryFullName(
    repository.full_name,
    `GitHub installation repository ${index} full_name`
  );
  if (typeof repository.private !== 'boolean') {
    throw new Error(
      `GitHub installation repository ${index} private must be boolean`
    );
  }
  return { id: repository.id, full_name: fullName, private: repository.private };
}

function validateAuthFragment(params) {
  const flags = params.getAll(AUTH_FLAG_PARAM);
  if (flags.length !== 1 || flags[0] !== '1') {
    throw new Error('GitHub auth callback flag must occur once with value "1"');
  }
  const tokens = params.getAll(AUTH_TOKEN_PARAM);
  const lifetimes = params.getAll(AUTH_TOKEN_EXPIRES_PARAM);
  const errors = params.getAll(AUTH_ERROR_PARAM);
  if (
    tokens.length > 1 ||
    errors.length > 1 ||
    (tokens.length === 0) === (errors.length === 0) ||
    lifetimes.length !== tokens.length
  ) {
    throw new Error(
      'GitHub auth callback must contain exactly one token with its lifetime, or one error'
    );
  }
  const token = tokens.length ? tokens[0] : null;
  const error = errors.length ? errors[0] : null;
  if (token !== null && (!token || /^\s|\s$/.test(token))) {
    throw new Error('GitHub auth callback token must be an exact nonblank string');
  }
  const expiresIn = lifetimes.length ? Number(lifetimes[0]) : null;
  if (
    expiresIn !== null &&
    (!/^[1-9][0-9]*$/.test(lifetimes[0]) || !Number.isSafeInteger(expiresIn))
  ) {
    throw new Error('GitHub auth callback token lifetime must be a positive whole number of seconds');
  }
  if (error !== null && (!error || /^\s|\s$/.test(error))) {
    throw new Error('GitHub auth callback error must be an exact nonblank string');
  }
  return { token, expiresIn, error };
}

function readAuthResultFromUrl(urlString) {
  if (typeof window === 'undefined') return null;
  const candidate =
    urlString === null || urlString === undefined || urlString === ''
      ? window.location?.href
      : urlString;
  if (typeof candidate !== 'string') {
    throw new Error('GitHub auth callback URL must be a string');
  }
  const href = candidate;
  if (!href) return null;

  /** @type {URL} */
  let url;
  try {
    url = new URL(href);
  } catch (cause) {
    const error = new Error('GitHub auth callback URL is invalid');
    error.cause = cause;
    throw error;
  }

  const hash = String(url.hash || '').replace(/^#/, '');
  if (!hash) return null;

  const {
    ownsFragment,
    cleanedHash,
    hasRetainedSegments,
  } = scrubAuthFragment(hash);
  if (!ownsFragment) return null;

  const params = new URLSearchParams(hash);
  const retained = hasRetainedSegments ? takeStateField(cleanedHash) : { hash: '', kept: 0, state: null };
  // Every other segment is kept byte for byte (an empty one too); a fragment that held only the state goes.
  const cleanedUrl =
    `${url.origin}${url.pathname}${url.search}` +
    `${retained.kept > 0 ? `#${retained.hash}` : ''}`;

  try {
    const { token, expiresIn, error } = validateAuthFragment(params);
    return { token, expiresIn, error, state: retained.state, cleanedUrl, validationError: null };
  } catch (validationError) {
    return { token: null, expiresIn: null, error: null, state: null, cleanedUrl, validationError };
  }
}

export class GitHubAuthSession extends EventEmitter {
  /**
   * @param {{transport?: object|null}} [options] - `transport`: the Worker
   *   transport every request uses (`worker-request.js`; tests give one on
   *   virtual time); the Worker origin's own by default
   */
  constructor({ transport = null } = {}) {
    super();
    this._transport = transport;
    if (typeof AbortController !== 'function') {
      throw new Error('AbortController is required for GitHub annotation requests');
    }
    this._requestGeneration = 0;
    this._generationAbort = new AbortController();
    this._verifiedWorkerOrigin = null;
    this._token = null;
    this._user = null;
    /** When the token expires (milliseconds since the epoch), or null. */
    this._expiresAt = null;
    this._loadFromSessionStorage();
    // A token that reaches its end is forgotten: the next annotation request
    // asks for a new sign-in rather than failing at GitHub.
    onSignInChange(({ name, change }) => {
      if (name === SIGN_IN_NAME && change === 'expired' && this._token !== null) this._forget();
    });
  }

  _advanceRequestGeneration() {
    const retiredAbort = this._generationAbort;
    const nextGeneration = this._requestGeneration + 1;
    this._requestGeneration = nextGeneration;
    this._generationAbort = new AbortController();
    retiredAbort.abort();
    return nextGeneration;
  }

  _createRequestOwner(
    signal = null,
    token = this._token,
    { candidate = false } = {}
  ) {
    const callerSignal = requireSignalOrNull(signal, 'GitHub authentication request signal');
    const sessionSignal = this._generationAbort.signal;
    const owner = {
      candidate,
      callerSignal,
      generation: this._requestGeneration,
      getAbortCause: () => (
        sessionSignal.aborted ? 'session' : null
      ),
      token,
      sessionSignal,
      signal: sessionSignal,
      cleanup: () => {},
    };
    if (callerSignal === null) return owner;

    const controller = new AbortController();
    let abortCause = null;
    const abortWithCause = (cause) => {
      if (abortCause === null) abortCause = cause;
      controller.abort();
    };
    const stopSession = onAbort(sessionSignal, () => abortWithCause('session'));
    const stopCaller = onAbort(callerSignal, () => abortWithCause('caller'));
    owner.getAbortCause = () => abortCause;
    owner.signal = controller.signal;
    owner.cleanup = () => {
      stopSession();
      stopCaller();
    };
    return owner;
  }

  _isRequestOwnerCurrent(owner) {
    return (
      owner.generation === this._requestGeneration &&
      owner.sessionSignal === this._generationAbort.signal &&
      !owner.sessionSignal.aborted &&
      (owner.candidate || owner.token === this._token)
    );
  }

  _assertRequestOwnerCurrent(owner, cause = undefined) {
    const abortCause = owner.getAbortCause();
    if (
      abortCause === 'caller' ||
      (
        abortCause === null &&
        owner.callerSignal?.aborted &&
        !owner.sessionSignal.aborted
      )
    ) {
      throw requestCancelled(cause?.url ?? null, cause);
    }
    if (!this._isRequestOwnerCurrent(owner)) {
      throw createAuthSupersededError(cause);
    }
  }

  /**
   * Tell the `changed` listeners who is signed in. A listener that changes
   * it (signs out) has the newer news told; the rest do not hear the older.
   * Returns whether what was told is still current.
   */
  _emitChanged() {
    const generation = this._requestGeneration;
    const token = this._token;
    const user = this._user;
    return this.emitWhile(
      'changed',
      Object.freeze({ token, user: user === null ? null : Object.freeze({ ...user }) }),
      () => (
        generation === this._requestGeneration &&
        token === this._token &&
        user === this._user
      ),
    );
  }

  /**
   * Adopt the persisted session, if there is exactly one valid session to adopt.
   *
   * The persisted entry is a cache of a Worker-verified identity, never the
   * source of truth, so an unreadable or malformed entry must degrade to
   * "signed out" rather than fail construction. Failing here is unrecoverable
   * in practice: the constructor runs inside application startup, nothing else
   * writes this key, and a rejected entry that stays in storage would reject
   * every later construction in the same browsing session too. The malformed
   * entry is therefore discarded, so a reload recovers on its own.
   *
   * Validation is not relaxed by this: a session that fails any check is
   * refused exactly as before. Only the consequence of refusing it changes.
   */
  _loadFromSessionStorage() {
    this._token = null;
    this._user = null;
    let rawSession;
    try {
      rawSession = readSessionItem();
    } catch {
      // A browser that refuses session storage has no persisted identity to
      // adopt. Sign-in reports its own storage failure when it cannot persist.
      return;
    }
    if (rawSession === null) return;

    let token;
    let user;
    let expiresAt;
    try {
      const session = parseExactJson(rawSession, {
        path: 'GitHub auth session',
      });
      requireExactObjectKeys(
        session,
        ['expiresAt', 'token', 'user'],
        'Stored GitHub auth session'
      );
      if (
        typeof session.token !== 'string' ||
        !session.token ||
        /^\s|\s$/.test(session.token)
      ) {
        throw new Error('Stored GitHub token must be an exact nonblank string');
      }
      if (!Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now()) {
        throw new Error('Stored GitHub token has expired');
      }
      token = session.token;
      expiresAt = session.expiresAt;
      user = Object.freeze({ ...assertStoredGitHubUser(session.user) });
    } catch {
      try {
        removeSessionItem();
      } catch {
        // Storage that refuses removal also refused to hand back a usable
        // identity, so there is nothing left to adopt in either outcome.
      }
      return;
    }
    this._token = token;
    this._user = user;
    this._expiresAt = expiresAt;
    setSignInExpiry(SIGN_IN_NAME, expiresAt);
  }

  _persistAuthenticatedState(token, user, expiresAt) {
    if (
      typeof token !== 'string' ||
      !token ||
      /^\s|\s$/.test(token) ||
      !Number.isSafeInteger(expiresAt)
    ) {
      throw new Error(
        'GitHub auth session requires one exact token, its expiry and user identity'
      );
    }
    writeSessionItem(
      JSON.stringify({
        expiresAt,
        token,
        user: assertStoredGitHubUser(user),
      })
    );
  }

  async _fetchUserForOwner(owner) {
    const workerOrigin = this.getWorkerOrigin();
    if (this._verifiedWorkerOrigin !== workerOrigin) {
      await this._verifyWorkerForOwner(owner);
    }
    this._assertRequestOwnerCurrent(owner);
    const url = `${workerOrigin}/auth/user`;
    let userResponse;
    try {
      userResponse = await fetchJson(url, {
        transport: this._transport,
        method: 'GET',
        headers: { Authorization: `Bearer ${owner.token}` },
        signal: owner.signal,
      });
    } catch (error) {
      this._assertRequestOwnerCurrent(owner, error);
      throw error;
    }
    this._assertRequestOwnerCurrent(owner);
    return Object.freeze({
      ...assertGitHubUserResponse(userResponse),
    });
  }

  async _verifyWorkerForOwner(owner) {
    const workerOrigin = this.getWorkerOrigin();
    if (this._verifiedWorkerOrigin === workerOrigin) {
      this._assertRequestOwnerCurrent(owner);
      return true;
    }
    let response;
    try {
      response = await fetchJson(`${workerOrigin}/`, {
        transport: this._transport,
        method: 'GET',
        signal: owner.signal,
      });
    } catch (error) {
      this._assertRequestOwnerCurrent(owner, error);
      // Not reached, cut off or failing (a 5xx) is what it is; an answer
      // that is not the Worker's root document is an incompatible service.
      if (
        isCancellation(error) ||
        error?.code === 'GITHUB_AUTH_SUPERSEDED' ||
        error?.code === WORKER_UNREACHABLE ||
        error?.code === WORKER_RESPONSE_CUT ||
        error?.status >= 500
      ) {
        throw error;
      }
      throw createWorkerIncompatibleError(workerOrigin, error);
    }
    this._assertRequestOwnerCurrent(owner);
    assertWorkerCompatibilityDocument(response, workerOrigin);
    this._assertRequestOwnerCurrent(owner);
    this._verifiedWorkerOrigin = workerOrigin;
    return true;
  }

  _publishAuthenticatedOwner(owner, user) {
    this._assertRequestOwnerCurrent(owner);
    let publicationGeneration = owner.generation;
    if (owner.candidate) {
      publicationGeneration = this._advanceRequestGeneration();
      if (publicationGeneration !== this._requestGeneration) {
        throw createAuthSupersededError();
      }
    }
    const expiresAt = owner.expiresAt ?? this._expiresAt;
    this._persistAuthenticatedState(owner.token, user, expiresAt);
    if (publicationGeneration !== this._requestGeneration) {
      throw createAuthSupersededError();
    }
    this._token = owner.token;
    this._user = user;
    this._expiresAt = expiresAt;
    setSignInExpiry(SIGN_IN_NAME, expiresAt);
    if (!this._emitChanged()) {
      throw createAuthSupersededError();
    }
  }

  getWorkerOrigin() {
    return getGitHubWorkerOrigin();
  }

  getToken() {
    return this._token;
  }

  getUser() {
    return this._user === null ? null : { ...this._user };
  }

  isAuthenticated() {
    return this._token !== null && this._user !== null;
  }

  async fetchUser({ signal = null } = {}) {
    const token = this._token;
    if (!token) return null;
    const owner = this._createRequestOwner(signal, token);
    try {
      const user = await this._fetchUserForOwner(owner);
      this._publishAuthenticatedOwner(owner, user);
      return { ...user };
    } finally {
      owner.cleanup();
    }
  }

  async ensureWorkerCompatible({ signal = null } = {}) {
    const owner = this._createRequestOwner(signal);
    try {
      await this._verifyWorkerForOwner(owner);
      return true;
    } finally {
      owner.cleanup();
    }
  }

  async _acceptToken(token, expiresIn) {
    if (typeof token !== 'string' || !token || /^\s|\s$/.test(token)) {
      throw new Error('Missing or inexact GitHub token');
    }
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 1) {
      throw new Error('A GitHub token needs its lifetime');
    }
    const expiresAt = Date.now() + expiresIn * 1000;

    const transitionGeneration = this._advanceRequestGeneration();
    if (transitionGeneration !== this._requestGeneration) {
      throw createAuthSupersededError();
    }
    const owner = this._createRequestOwner(
      null,
      token,
      { candidate: true }
    );
    owner.expiresAt = expiresAt;
    try {
      const user = await this._fetchUserForOwner(owner);
      this._publishAuthenticatedOwner(owner, user);
      return { token, user: { ...user } };
    } finally {
      owner.cleanup();
    }
  }

  async completeSignInFromRedirect({ url = null } = {}) {
    if (typeof window === 'undefined') throw new Error('GitHub login requires a browser context');
    // The head script (`app/ui/core/auth-fragment-init.js`) took the sign-in's
    // fragment out of the address before anything else ran; it is read once.
    let callbackUrl = url;
    const taken = window.cellucidGitHubAuthFragment;
    if (callbackUrl === null && typeof taken === 'string') {
      delete window.cellucidGitHubAuthFragment;
      callbackUrl = `${window.location.origin}${window.location.pathname}${window.location.search}${taken}`;
    }
    const result = readAuthResultFromUrl(callbackUrl);
    if (!result) return null;
    // One answer per sign-in started: the state is taken whatever the answer.
    const started = takeSignInState();

    if (result.cleanedUrl) {
      if (typeof window.history?.replaceState !== 'function') {
        throw new Error('History.replaceState is required to remove the GitHub token fragment');
      }
      window.history.replaceState(
        window.history.state,
        '',
        result.cleanedUrl
      );
    }

    if (result.validationError) {
      throw result.validationError;
    }

    if (result.error) {
      const err = new Error(result.error);
      err.code = 'GITHUB_AUTH_ERROR';
      throw err;
    }

    if (!result.token) {
      const err = new Error('Missing GitHub token');
      err.code = 'GITHUB_AUTH_MISSING_TOKEN';
      throw err;
    }

    if (started === null || result.state !== started) {
      const err = new Error(
        'This GitHub sign-in was not started in this tab, so it was not used: a link can carry ' +
        'someone else\'s sign-in. Sign in again from Community annotation.'
      );
      err.code = 'GITHUB_AUTH_NOT_STARTED_HERE';
      throw err;
    }

    return this._acceptToken(result.token, result.expiresIn);
  }

  async signIn({ returnTo = null, signal = null } = {}) {
    if (typeof window === 'undefined') throw new Error('GitHub login requires a browser context');
    const ownerSignal = requireSignalOrNull(signal, 'GitHub authentication request signal');
    const workerOrigin = this.getWorkerOrigin();
    const rawHash = String(window.location.hash || '').replace(/^#/, '');
    const retainedFragment = rawHash
      ? scrubAuthFragment(rawHash)
      : { cleanedHash: '', hasRetainedSegments: false };
    const rt = returnTo === null
      ? (
        `${window.location.origin}${window.location.pathname}${window.location.search}` +
        (
          retainedFragment.hasRetainedSegments
            ? `#${retainedFragment.cleanedHash}`
            : ''
        )
      )
      : returnTo;
    if (typeof rt !== 'string' || !rt || /^\s|\s$/.test(rt)) {
      throw new Error('GitHub sign-in returnTo must be an exact nonblank URL');
    }
    const url = new URL(getGitHubLoginUrl(workerOrigin));
    if (typeof window.location.assign !== 'function') {
      throw new Error('GitHub sign-in requires location.assign()');
    }
    this._advanceRequestGeneration();
    const owner = this._createRequestOwner(
      ownerSignal,
      null,
      { candidate: true }
    );
    try {
      await this._verifyWorkerForOwner(owner);
      this._assertRequestOwnerCurrent(owner);
      // The return address names a fresh state in its fragment (every other
      // part of it kept byte for byte); the answer is taken only with it.
      const state = beginSignInState();
      const cut = rt.indexOf('#');
      const kept = cut === -1 ? '' : takeStateField(rt.slice(cut + 1)).hash;
      url.searchParams.set('return_to', `${cut === -1 ? rt : rt.slice(0, cut)}#${kept === '' ? '' : `${kept}&`}${SIGN_IN_STATE_PARAM}=${state}`);
      window.location.assign(url.toString());
      return url.toString();
    } finally {
      owner.cleanup();
    }
  }

  /**
   * Sign out: forget the token here at once, and revoke it at GitHub (through
   * the worker, which holds the app's credentials). The revocation is sent
   * whether or not it can be awaited (`keepalive`), so a page closed right
   * after still ends the token.
   *
   * @returns {Promise<boolean>} Whether GitHub revoked it (true with nothing
   *   to revoke). False when the worker could not (unreachable, or a worker
   *   deployed before `/auth/revoke`): the token then stays valid until it
   *   expires, which the caller says.
   */
  signOut() {
    const token = this._token;
    this._forget();
    return token === null ? Promise.resolve(true) : this._revoke(token);
  }

  /**
   * Forget a sign-in GitHub refused (it expired or was revoked): nothing is
   * left to revoke, so nothing is asked of GitHub.
   */
  forgetRefused() {
    this._forget();
  }

  /** Forget the sign-in in this tab (sign-out, or a token that expired). @private */
  _forget() {
    const hadAuthenticatedState = this.isAuthenticated();
    const signOutGeneration = this._advanceRequestGeneration();
    if (signOutGeneration !== this._requestGeneration) return;
    // Storage removal comes first on purpose: a sign-out that cannot be made
    // durable is refused rather than reported, so the in-memory session can
    // never claim to be signed out while a reload would restore the token.
    removeSessionItem();
    if (signOutGeneration !== this._requestGeneration) return;
    this._expiresAt = null;
    if (!hadAuthenticatedState) {
      this._token = null;
      return;
    }
    this._token = null;
    this._user = null;
    this._emitChanged();
  }

  /** @private @returns {Promise<boolean>} */
  async _revoke(token) {
    try {
      const response = await globalThis.fetch(`${this.getWorkerOrigin()}/auth/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        keepalive: true,
      });
      return response.status === 204;
    } catch {
      return false;
    }
  }

  /**
   * Every page of one Worker collection, in order, merged by item id (a
   * listing read page by page can shift while it is read: an item seen on
   * two pages is kept once, as the later page has it).
   */
  async _listCollection({ path, method, body = null, signal, label, projectItem, identityOf }) {
    const token = this._token;
    if (!token) throw new Error('Not signed in');
    const owner = this._createRequestOwner(signal);
    const workerOrigin = this.getWorkerOrigin();
    try {
      if (this._verifiedWorkerOrigin !== workerOrigin) {
        await this._verifyWorkerForOwner(owner);
      }
      const byId = new Map();
      for (let page = 1; page !== null;) {
        let response;
        try {
          response = await fetchJson(`${workerOrigin}${path}?page=${page}`, {
            transport: this._transport,
            method,
            headers: body === null
              ? { Authorization: `Bearer ${token}` }
              : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body,
            signal: owner.signal,
          });
        } catch (error) {
          this._assertRequestOwnerCurrent(owner, error);
          throw error;
        }
        this._assertRequestOwnerCurrent(owner);
        const result = assertCollectionPage(response, page, `${label} page ${page}`, projectItem, identityOf);
        for (const item of result.items) {
          byId.delete(item.id);
          byId.set(item.id, item);
        }
        page = result.nextPage;
      }
      return [...byId.values()];
    } finally {
      owner.cleanup();
    }
  }

  async listInstallations({ signal = null } = {}) {
    const installations = await this._listCollection({
      path: '/auth/installations',
      method: 'GET',
      signal,
      label: 'GitHub installations endpoint',
      projectItem: projectInstallation,
      identityOf: (item) => [`id:${item.id}`, `account:${item.account.login.toLowerCase()}`],
    });
    return { installations };
  }

  async listInstallationRepos(installationId, { signal = null } = {}) {
    if (!this._token) throw new Error('Not signed in');
    if (!Number.isSafeInteger(installationId) || installationId < 1) {
      throw new Error('Invalid installation_id');
    }
    const repositories = await this._listCollection({
      path: '/auth/installation-repos',
      method: 'POST',
      body: { installation_id: installationId },
      signal,
      label: 'GitHub installation repositories endpoint',
      projectItem: projectRepository,
      identityOf: (item) => [`id:${item.id}`, `name:${item.full_name.toLowerCase()}`],
    });
    return { repositories };
  }
}

let _singleton = null;

export function getGitHubAuthSession() {
  if (!_singleton) _singleton = new GitHubAuthSession();
  return _singleton;
}
