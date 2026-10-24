/**
 * The Transfers log: every read of linked data, where it comes from, why it
 * is read, how much has come in, and where the bytes go.
 *
 * Linked data is read in place: only what a view needs is requested from the
 * host. An entry starts when a link opens a file or a catalog and counts the
 * bytes and requests made for it; the Transfers panel shows the entries, and
 * each start and finish is also written to the console as
 * `[cellucid:transfer]`. Nothing here is a limit: the log only reports.
 *
 * An entry's `key` is the URL its reads go to: a file's URL, or a catalog's
 * base URL, which every file of the catalog starts with. No entry ever holds
 * a token or a signed query string: `from` is host and path only.
 *
 * @module data/transfer-log
 */

/**
 * @typedef {Object} TransferEntry
 * @property {string} key - URL (file) or URL prefix (catalog) the reads go to
 * @property {string} label - What is read, as the app names it
 * @property {string} from - Host and path, without a query string
 * @property {string} why - Why the bytes are read, in plain words
 * @property {'in-place'|'download'} mode
 * @property {'memory'} destination - Where the bytes go
 * @property {number} bytes - Bytes received so far
 * @property {number} requests - Requests made so far
 * @property {number|null} total - Size of the file, when known
 * @property {'active'|'closed'|'failed'} status
 * @property {string|null} detail - The failure, for a failed entry
 * @property {number|null} lastArrivalAt - When bytes last arrived (`performance.now()`), null before any
 * @property {string|null} retrying - Why a request is being made again, naming it, until bytes arrive again
 */

/** Where the bytes go, as the panel and the console say it. */
export const TRANSFER_DESTINATIONS = Object.freeze({
  memory: 'memory only: nothing is saved to disk, and it is released when the dataset closes',
});

function describeOrigin(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export { formatBytes as formatTransferBytes };

export class TransferLog {
  constructor({ console: output = globalThis.console } = {}) {
    /** @type {Map<string, TransferEntry>} */
    this._entries = new Map();
    this._listeners = new Set();
    this._console = output;
  }

  /**
   * Start (or restart) the entry for one key.
   *
   * @param {{key: string, label: string, why: string,
   *   mode?: 'in-place'|'download', total?: number|null}} options
   * @returns {TransferEntry}
   */
  begin({ key, label, why, mode = 'in-place', total = null }) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('A transfer needs the URL its reads go to.');
    }
    const entry = {
      key,
      label,
      from: describeOrigin(key),
      why,
      mode,
      destination: 'memory',
      bytes: 0,
      requests: 0,
      total,
      status: 'active',
      detail: null,
      lastArrivalAt: null,
      retrying: null,
    };
    this._entries.delete(key);
    this._entries.set(key, entry);
    this._console?.info?.(
      `[cellucid:transfer] ${mode === 'download' ? 'downloading' : 'reading in place'} ` +
      `${label} from ${entry.from}` +
      (total === null ? '' : ` (${formatBytes(total)} file)`) +
      ` — ${why}; ${TRANSFER_DESTINATIONS.memory}.`
    );
    this._publish();
    return entry;
  }

  /**
   * The active entry a URL belongs to: its own entry, or the catalog whose
   * base URL it starts with.
   *
   * @param {string} url
   * @returns {TransferEntry|null}
   */
  entryFor(url) {
    const exact = this._entries.get(url);
    if (exact?.status === 'active') return exact;
    for (const entry of this._entries.values()) {
      if (entry.status === 'active' && entry.key.endsWith('/') && url.startsWith(entry.key)) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Count received bytes for a URL. Absolute totals (from the reader worker,
   * which counts per file) replace; increments add.
   *
   * @param {string} url
   * @param {{bytes: number, requests?: number, absolute?: boolean}} reading
   */
  record(url, { bytes, requests = 1, absolute = false }) {
    const entry = this.entryFor(url);
    if (entry === null || !Number.isFinite(bytes) || bytes < 0) return;
    if (absolute) {
      entry.bytes = bytes;
      entry.requests = requests;
    } else {
      entry.bytes += bytes;
      entry.requests += requests;
    }
    entry.lastArrivalAt = performance.now();
    entry.retrying = null;
    this._publish();
  }

  /**
   * A request for a URL failed for a moment and is made again: why, naming
   * the request (`retrying`), until bytes arrive again.
   *
   * @param {string} url
   * @param {string} message
   */
  retrying(url, message) {
    const entry = this.entryFor(url);
    if (entry === null) return;
    entry.retrying = String(message);
    this._console?.warn?.(`[cellucid:transfer] ${entry.label}: ${entry.retrying}`);
    this._publish();
  }

  /**
   * Bytes of a request still under way arrive for a URL: its entry is
   * receiving (`lastArrivalAt`), and listeners hear of it (a read of one large
   * request shows that it is alive before it completes).
   *
   * @param {string} url
   */
  arriving(url) {
    const entry = this.entryFor(url);
    if (entry === null) return;
    entry.lastArrivalAt = performance.now();
    entry.retrying = null;
    this._publish();
  }

  /**
   * Name an entry as the app names its dataset, once that is known.
   *
   * @param {TransferEntry} entry - As returned by `begin`
   * @param {string} label
   */
  rename(entry, label) {
    if (this._entries.get(entry?.key) !== entry || typeof label !== 'string' || label === '') return;
    entry.label = label;
    this._publish();
  }

  /**
   * Close an entry: the dataset was closed, or its reads failed. Only the
   * entry `begin` returned is closed, never a newer one for the same URL.
   *
   * @param {TransferEntry} entry - As returned by `begin`
   * @param {{error?: Error|null}} [options]
   */
  finish(entry, { error = null } = {}) {
    if (this._entries.get(entry?.key) !== entry || entry.status !== 'active') return;
    entry.status = error === null ? 'closed' : 'failed';
    entry.detail = error === null ? null : String(error?.message ?? error);
    this._console?.info?.(
      `[cellucid:transfer] ${entry.status === 'failed' ? 'failed' : 'closed'} ` +
      `${entry.label} from ${entry.from}: ${formatBytes(entry.bytes)} in ` +
      `${entry.requests} request${entry.requests === 1 ? '' : 's'}` +
      (entry.detail === null ? '.' : ` — ${entry.detail}`)
    );
    this._publish();
  }

  /** @returns {ReadonlyArray<Readonly<TransferEntry>>} newest first */
  entries() {
    return Object.freeze(
      [...this._entries.values()].reverse().map(entry => Object.freeze({ ...entry }))
    );
  }

  /** Drop finished entries. */
  clearFinished() {
    for (const [key, entry] of this._entries) {
      if (entry.status !== 'active') this._entries.delete(key);
    }
    this._publish();
  }

  /**
   * @param {(entries: ReadonlyArray<TransferEntry>) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _publish() {
    if (this._listeners.size === 0) return;
    const entries = this.entries();
    for (const listener of this._listeners) {
      try {
        listener(entries);
      } catch (error) {
        this._console?.error?.('[cellucid:transfer] A Transfers display failed:', error);
      }
    }
  }
}

let defaultLog = null;

/** @returns {TransferLog} */
export function getTransferLog() {
  defaultLog ??= new TransferLog();
  return defaultLog;
}
