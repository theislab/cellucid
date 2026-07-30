/**
 * Bounded, exact client for the public ORCID endpoints used by the identity UI.
 *
 * The public API is an external trust boundary: every response is streamed
 * through a byte ceiling and parsed with duplicate-key rejection before its
 * small UI projection is validated.
 */

import {
  assertExactOptionalProfileText,
  assertExactOrcidId,
  parseOrcidExpandedSearch,
  parseOrcidPersonName,
} from './profile-identifiers.js';
import { parseExactJson } from './wire-contract.js';

export const ORCID_RESPONSE_MAX_UTF8_BYTES = 256 * 1024;
export const ORCID_EXPANDED_SEARCH_MAX_RESULTS = 8;

const ORCID_API_ORIGIN = 'https://pub.orcid.org';

function assertAbortSignalOrNull(signal) {
  if (
    signal !== null &&
    (
      typeof signal !== 'object' ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function'
    )
  ) {
    throw new TypeError('ORCID request signal must be an AbortSignal or exact null');
  }
  return signal;
}

function throwIfAborted(signal) {
  if (signal === null || !signal.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('ORCID request was cancelled');
  error.name = 'AbortError';
  throw error;
}

function createResponseError(message, code, cause = undefined) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function responseTooLarge(label) {
  return createResponseError(
    `${label} exceeds ${ORCID_RESPONSE_MAX_UTF8_BYTES} bytes`,
    'ORCID_RESPONSE_TOO_LARGE'
  );
}

async function cancelResponseBody(response) {
  if (typeof response?.body?.cancel !== 'function') return;
  try {
    await response.body.cancel();
  } catch {
    // The authoritative protocol/size error remains the public outcome.
  }
}

function knownResponseByteLength(response) {
  const raw = response?.headers?.get?.('content-length') ?? null;
  if (raw === null || raw === '' || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
}

/**
 * Read one ORCID response without ever buffering more than the public ceiling.
 *
 * @param {Response|object} response
 * @param {{label:string,signal?:AbortSignal|null}} options
 * @returns {Promise<any>}
 */
export async function readBoundedOrcidJson(
  response,
  { label, signal = null }
) {
  const ownerSignal = assertAbortSignalOrNull(signal);
  if (typeof label !== 'string' || !label || /^\s|\s$/.test(label)) {
    throw new TypeError('ORCID response label must be an exact nonblank string');
  }
  try {
    throwIfAborted(ownerSignal);
  } catch (primary) {
    await cancelResponseBody(response);
    throw primary;
  }

  const knownByteLength = knownResponseByteLength(response);
  if (
    knownByteLength !== null &&
    knownByteLength > ORCID_RESPONSE_MAX_UTF8_BYTES
  ) {
    const primary = responseTooLarge(label);
    await cancelResponseBody(response);
    throw primary;
  }

  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    await cancelResponseBody(response);
    throw createResponseError(
      `${label} body must expose a readable byte stream`,
      'ORCID_RESPONSE_INVALID'
    );
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });
  const textParts = [];
  let byteLength = 0;
  let streamDone = false;
  let readerCancelled = false;
  const cancelLiveReader = async () => {
    if (streamDone || readerCancelled) return;
    readerCancelled = true;
    try {
      await reader.cancel();
    } catch {
      // The authoritative protocol/size error remains the public outcome.
    }
  };

  try {
    while (true) {
      const part = await reader.read();
      throwIfAborted(ownerSignal);
      if (part.done) {
        streamDone = true;
        try {
          textParts.push(decoder.decode());
        } catch (cause) {
          throw createResponseError(
            `${label} is not valid UTF-8`,
            'ORCID_RESPONSE_INVALID',
            cause
          );
        }
        break;
      }
      if (!(part.value instanceof Uint8Array)) {
        const primary = createResponseError(
          `${label} stream returned a non-byte chunk`,
          'ORCID_RESPONSE_INVALID'
        );
        await cancelLiveReader();
        throw primary;
      }
      byteLength += part.value.byteLength;
      if (byteLength > ORCID_RESPONSE_MAX_UTF8_BYTES) {
        const primary = responseTooLarge(label);
        await cancelLiveReader();
        throw primary;
      }
      try {
        textParts.push(decoder.decode(part.value, { stream: true }));
      } catch (cause) {
        const primary = createResponseError(
          `${label} is not valid UTF-8`,
          'ORCID_RESPONSE_INVALID',
          cause
        );
        await cancelLiveReader();
        throw primary;
      }
    }
  } catch (error) {
    let primary = error;
    if (ownerSignal?.aborted) {
      try {
        throwIfAborted(ownerSignal);
      } catch (abortError) {
        primary = abortError;
      }
    }
    await cancelLiveReader();
    throw primary;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A settled response reader may already have released its lock.
    }
  }

  throwIfAborted(ownerSignal);
  const text = textParts.join('');
  try {
    if (!text) throw new Error('empty response body');
    return parseExactJson(text, { path: label });
  } catch (cause) {
    throw createResponseError(
      `${label} returned invalid JSON: ${cause?.message || cause}`,
      'ORCID_RESPONSE_INVALID',
      cause
    );
  }
}

function requestOptions(signal) {
  return {
    method: 'GET',
    headers: { Accept: 'application/vnd.orcid+json' },
    signal,
    cache: 'no-store',
    credentials: 'omit',
    mode: 'cors',
    referrerPolicy: 'no-referrer',
  };
}

async function fetchSuccessfulJson(url, { label, signal }) {
  const ownerSignal = assertAbortSignalOrNull(signal);
  throwIfAborted(ownerSignal);
  let response;
  try {
    response = await fetch(url, requestOptions(ownerSignal));
  } catch (error) {
    throwIfAborted(ownerSignal);
    throw error;
  }
  try {
    throwIfAborted(ownerSignal);
  } catch (primary) {
    await cancelResponseBody(response);
    throw primary;
  }
  if (!response?.ok) {
    const status = Number.isSafeInteger(response?.status)
      ? response.status
      : 0;
    const primary = new Error(`${label} failed (HTTP ${status})`);
    await cancelResponseBody(response);
    throw primary;
  }
  return readBoundedOrcidJson(response, {
    label: `${label} response`,
    signal: ownerSignal,
  });
}

export async function fetchOrcidPerson(orcidId, { signal = null } = {}) {
  const id = assertExactOrcidId(orcidId);
  const document = await fetchSuccessfulJson(
    `${ORCID_API_ORIGIN}/v3.0/${encodeURIComponent(id)}/person`,
    { label: 'ORCID lookup', signal }
  );
  return {
    name: parseOrcidPersonName(document),
    orcid: id,
  };
}

export async function fetchOrcidExpandedSearch(
  query,
  { signal = null } = {}
) {
  const exactQuery = assertExactOptionalProfileText(
    query,
    'ORCID search query',
    240
  );
  if (!exactQuery) return [];
  const document = await fetchSuccessfulJson(
    (
      `${ORCID_API_ORIGIN}/v3.0/expanded-search/?q=` +
      `${encodeURIComponent(exactQuery)}` +
      `&rows=${ORCID_EXPANDED_SEARCH_MAX_RESULTS}`
    ),
    { label: 'ORCID search', signal }
  );
  return parseOrcidExpandedSearch(document, {
    maximumResults: ORCID_EXPANDED_SEARCH_MAX_RESULTS,
  });
}
