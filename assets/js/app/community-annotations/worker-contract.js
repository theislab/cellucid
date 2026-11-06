/**
 * What the community-annotation Worker (`_worker-code.js`) and the Cellucid
 * page agree on, in the one module both can import: the Worker's identity,
 * contract version and route inventory (its root `/` document), the headers
 * of its mutation protocol and the response headers a page may read, and the
 * URL fragment through which the OAuth callback hands the page a token.
 *
 * The Worker bundles this module. A page module that still keeps a copy of
 * one of these is held to it by
 * `tests/community-annotation-worker-duplication-contract.test.mjs`.
 *
 * Wire contract version 3: the route inventory below, in this order. A
 * Worker whose root document names another version is a different contract
 * (an older one must be redeployed; a newer one needs a reload of Cellucid).
 */

export const WORKER_SERVICE = 'Cellucid GitHub Auth';

export const WORKER_CONTRACT_VERSION = 3;

export const WORKER_ENDPOINTS = Object.freeze([
  '/auth/login',
  '/auth/callback',
  '/auth/revoke',
  '/auth/user',
  '/auth/installations',
  '/auth/installation-repos',
  '/cap/lookup-cells',
  '/graphql/snapshot',
  '/graphql/blobs',
  '/api/repos/*',
]);

/** A mutation's identity (a lowercase UUIDv4 the page sends) and its outcome (the Worker answers it). */
export const OPERATION_ID_HEADER = 'X-Cellucid-Operation-Id';
export const OPERATION_OUTCOME_HEADER = 'X-Cellucid-Operation-Outcome';

/**
 * The response headers a cross-origin page may read from every Worker answer
 * that relays GitHub (`Access-Control-Expose-Headers`), success or failure:
 * the conditional-request tag, GitHub's waits and request budget, GitHub's
 * request id, and the mutation outcome.
 */
export const WORKER_EXPOSED_RESPONSE_HEADERS = Object.freeze([
  'ETag',
  'Retry-After',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'X-RateLimit-Used',
  'X-RateLimit-Resource',
  'X-GitHub-Request-Id',
  OPERATION_ID_HEADER,
  OPERATION_OUTCOME_HEADER,
]);

/** The fragment fields the OAuth callback writes into the page's address. */
export const AUTH_FLAG_PARAM = 'cellucid_github_auth';
export const AUTH_TOKEN_PARAM = 'cellucid_github_token';
export const AUTH_TOKEN_EXPIRES_PARAM = 'cellucid_github_token_expires_in';
export const AUTH_ERROR_PARAM = 'cellucid_github_error';

const AUTH_FRAGMENT_PARAM_NAMES = new Set([
  AUTH_FLAG_PARAM,
  AUTH_TOKEN_PARAM,
  AUTH_TOKEN_EXPIRES_PARAM,
  AUTH_ERROR_PARAM,
]);

function readFragmentParamName(segment, index) {
  // Decode only the field name. Retaining the raw segment prevents unrelated
  // fragment bytes and separators from being normalized during auth cleanup.
  let candidate = segment;
  if (index === 0 && candidate.startsWith('?')) {
    candidate = candidate.slice(1);
  }
  if (!candidate) return null;
  const separatorIndex = candidate.indexOf('=');
  const rawName =
    separatorIndex === -1
      ? candidate
      : candidate.slice(0, separatorIndex);
  const probe = new URLSearchParams(`__cellucid_probe__=&${rawName}=`);
  const names = probe.keys();
  names.next();
  return names.next().value ?? null;
}

/**
 * Split a fragment (without its `#`) into the OAuth callback's fields and
 * everything else, keeping every other segment byte for byte.
 *
 * @param {string} hash
 * @returns {{ownsFragment: boolean, cleanedHash: string, hasRetainedSegments: boolean}}
 */
export function scrubAuthFragment(hash) {
  const segments = hash.split('&');
  let ownsFragment = false;
  const retained = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const name = readFragmentParamName(segment, index);
    if (name !== null && AUTH_FRAGMENT_PARAM_NAMES.has(name)) {
      ownsFragment = true;
      continue;
    }
    retained.push(segment);
  }
  return {
    ownsFragment,
    cleanedHash: retained.join('&'),
    hasRetainedSegments: retained.length > 0,
  };
}
