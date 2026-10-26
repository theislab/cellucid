/**
 * One request to a provider's JSON API (Google Drive, Microsoft Graph,
 * Figshare), never left hanging and asked again while the host says it is
 * busy: HTTP 408, 429 or 5xx, and whatever else the provider names transient
 * (Drive answers its rate limits with 403), waiting as long as `Retry-After`
 * asks. Failures name the request by `label`, never by its URL, which may
 * carry an API key or name a token-bearing request.
 *
 * @module data/sources/api-request
 */

import { DataSourceError, DataSourceErrorCode } from '../data-source.js';
import {
  ByteSourceError,
  BYTE_SOURCE_FAILURES,
  fetchOnce,
  isTransientStatus,
  withRetries,
} from '../../formats/io/byte-source.js';

/**
 * @param {string} url
 * @param {{label: string, headers?: Object<string, string>, signal?: AbortSignal|null,
 *   fetchImpl?: typeof fetch, transient?: (status: number, body: unknown) => boolean}} options
 * @returns {Promise<{status: number, ok: boolean, body: any, headers: Headers}>}
 *   `body`: the parsed JSON answer, or null when it is not JSON
 */
export async function requestJson(url, { label, headers = {}, signal = null, fetchImpl = globalThis.fetch, transient = () => false }) {
  try {
    return await withRetries(async () => {
      const { response, bytes } = await fetchOnce(url, { headers }, {
        fetchImpl,
        signal,
        label,
        wantsBody: () => true,
      });
      let body = null;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        body = null;
      }
      const status = response.status;
      if (isTransientStatus(status) || (!response.ok && transient(status, body))) {
        throw new ByteSourceError(
          status === 429 || status === 403 ? BYTE_SOURCE_FAILURES.RATE_LIMITED : BYTE_SOURCE_FAILURES.UNAVAILABLE,
          `${label}: the host is busy (HTTP ${status}).`,
          { status, retryAfter: response.headers.get('Retry-After') }
        );
      }
      return { status, ok: response.ok, body, headers: response.headers };
    }, { signal });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    if (error instanceof ByteSourceError) {
      throw new DataSourceError(
        Number.isInteger(error.status)
          ? `${label} is busy (HTTP ${error.status}). Try again later.`
          : `${label} could not be reached. Check your connection and try again.`,
        DataSourceErrorCode.NETWORK_ERROR,
        'link',
        Number.isInteger(error.status) ? { status: error.status } : {}
      );
    }
    throw error;
  }
}
