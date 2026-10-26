/**
 * Proof Key for Code Exchange (RFC 7636, S256) and the random values a
 * browser sign-in needs. A page has no secret to keep, so a sign-in proves it
 * started the flow it finishes with a one-time verifier held in memory.
 *
 * @module data/sources/auth/pkce
 */

function base64Url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A random URL-safe string of `bytes` random bytes (43 characters for 32).
 *
 * @param {number} [bytes]
 * @returns {string}
 */
function randomUrlSafe(bytes = 32) {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * The S256 code challenge of a verifier: BASE64URL(SHA-256(verifier)).
 *
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export async function codeChallengeOf(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/**
 * A fresh verifier, its challenge and a `state` value for one sign-in.
 *
 * @returns {Promise<{verifier: string, challenge: string, state: string}>}
 */
export async function createPkce() {
  const verifier = randomUrlSafe(32);
  return { verifier, challenge: await codeChallengeOf(verifier), state: randomUrlSafe(16) };
}
