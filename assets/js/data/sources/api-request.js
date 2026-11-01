/**
 * One request to a provider's JSON API (Google Drive, Microsoft Graph,
 * Figshare), never left hanging and asked again while the host says it is
 * busy: HTTP 408, 429 or 5xx, or a rate limit it answers with 403 (Google's
 * APIs: `isLimitAnswer`, the byte layer's one rule), within the host's
 * request budget and waiting as long as a `Retry-After` it names
 * (`formats/io/hosts.js`; `withRetries`, `formats/io/byte-source.js`). Failures name the request by `label`, never by its URL, which may
 * carry an API key or name a token-bearing request.
 *
 * @module data/sources/api-request
 */

import { DataSourceError, DataSourceErrorCode, hostFaultCause, hostFaultFailure } from '../data-source.js';
import {
  BYTE_SOURCE_FAILURES,
  ByteSourceError,
  fetchOnce,
  hostFaultOfStatus,
  isTransientAnswer,
  isUnanswered,
  transientStatusError,
  withRetries,
} from '../../formats/io/byte-source.js';
import { retryAfterMilliseconds } from '../../formats/io/hosts.js';
import { isCancellation } from '../../utils/abort.js';

/**
 * @param {string} url
 * @param {{label: string, headers?: Object<string, string>, signal?: AbortSignal|null,
 *   fetchImpl?: typeof fetch, cache?: RequestCache}} options
 *   `cache`: `'no-cache'` for an answer that names the version a link opens
 *   (asked of the host, never a cached answer taken as it is); the browser's
 *   default otherwise, under which Chromium keeps a signed-in request's
 *   preflight (`httpByteSource`)
 * @returns {Promise<{status: number, ok: boolean, body: any, headers: Headers}>}
 *   `body`: the parsed JSON answer, or null when it is not JSON
 */
export async function requestJson(url, { label, headers = {}, signal = null, fetchImpl = globalThis.fetch, cache = 'default' }) {
  try {
    return await withRetries(async () => {
      const { response, bytes } = await fetchOnce(url, { headers, ...(cache === 'default' ? {} : { cache }) }, {
        fetchImpl,
        signal,
        label,
        wantsBody: () => true,
      });
      const text = new TextDecoder().decode(bytes);
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const status = response.status;
      if (isTransientAnswer(response, text)) throw transientStatusError(response, label, text);
      return { status, ok: response.ok, body, headers: response.headers };
    }, { signal });
  } catch (error) {
    if (signal?.aborted || isCancellation(error)) throw error;
    if (error instanceof ByteSourceError && (error.code === BYTE_SOURCE_FAILURES.RATE_LIMITED || hostFaultOfStatus(error.status) !== null)) {
      throw hostFaultFailure({
        kind: error.code === BYTE_SOURCE_FAILURES.RATE_LIMITED ? 'limiting' : null,
        host: new URL(url).host,
        status: error.status ?? null,
        what: label,
        retryAfterMs: retryAfterMilliseconds(error.details?.retryAfter ?? null),
      }, { cause: hostFaultCause(error) });
    }
    // No answer a page may read: said by the link source, which knows the
    // provider (`LinkDataSource` `unansweredProviderError`: its outage, a
    // block, this computer offline, or every host silent at once).
    if (isUnanswered(error)) throw error;
    if (error instanceof ByteSourceError) {
      throw new DataSourceError(
        `${label} answered HTTP ${error.status}. Try again later.`,
        DataSourceErrorCode.NETWORK_ERROR,
        'link',
        Number.isInteger(error.status) ? { status: error.status } : {}
      );
    }
    throw error;
  }
}
