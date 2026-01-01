/**
 * @fileoverview Session bundle orchestrator.
 *
 * Responsibilities (per session-serializer-plan.md):
 * - enumerate contributors in a fixed order
 * - capture chunks + write a single-file `.cellucid-session` bundle
 * - load manifest, apply eager chunks, then schedule lazy chunks
 * - integrate NotificationCenter progress tracking
 * - own cancellation (AbortController) and isolate failures
 *
 * The orchestrator deliberately does NOT know feature internals.
 *
 * @module session/session-serializer
 */

import { readBundle } from './bundle/reader.js';
import { writeBundle } from './bundle/writer.js';
import {
  DEFAULT_MAX_UNCOMPRESSED_CHUNK_BYTES
} from './bundle/format.js';
import { gzipCompress, gzipDecompress } from './codecs/gzip.js';
import {
  buildSessionContext,
  datasetFingerprintMatches,
  getDatasetFingerprint
} from './session-context.js';

/**
 * @typedef {'eager'|'lazy'} ChunkPriority
 * @typedef {'json'|'binary'} ChunkKind
 * @typedef {'none'|'gzip'} ChunkCodec
 *
 * @typedef {object} SessionChunk
 * @property {string} id
 * @property {string} contributorId
 * @property {ChunkPriority} priority
 * @property {ChunkKind} kind
 * @property {ChunkCodec} codec
 * @property {string} label
 * @property {boolean} datasetDependent
 * @property {object|Uint8Array} payload
 * @property {string[]} [dependsOn]
 */

/**
 * @typedef {object} SessionContributor
 * @property {string} id
 * @property {(ctx: any) => Promise<SessionChunk[]|void>|SessionChunk[]|void} capture
 * @property {(ctx: any, chunkMeta: any, payload: any) => Promise<void>|void} restore
 */

/**
 * @param {AbortSignal | null | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

/**
 * Yield back to the browser so rendering stays responsive.
 * @returns {Promise<void>}
 */
function nextTick() {
  if (typeof requestAnimationFrame !== 'function') {
    throw new Error('Session restore requires requestAnimationFrame (dev-phase requirement).');
  }
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Download a Blob as a file.
 * @param {Blob} blob
 * @param {string} filename
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Basic manifest shape validation (untrusted input).
 * @param {any} manifest
 */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Invalid session manifest (expected JSON object).');
  }
  if (!Array.isArray(manifest.chunks)) {
    throw new Error('Invalid session manifest (missing chunks array).');
  }
  for (const entry of manifest.chunks) {
    const id = entry?.id;
    if (typeof id !== 'string' || !id) throw new Error('Invalid session manifest (chunk id missing).');
    if (typeof entry.contributorId !== 'string' || !entry.contributorId) {
      throw new Error(`Invalid session manifest (chunk contributorId missing): ${id}`);
    }
    if (entry.priority !== 'eager' && entry.priority !== 'lazy') {
      throw new Error(`Invalid session manifest (chunk priority): ${id}`);
    }
    if (entry.kind !== 'json' && entry.kind !== 'binary') {
      throw new Error(`Invalid session manifest (chunk kind): ${id}`);
    }
    if (entry.codec !== 'none' && entry.codec !== 'gzip') {
      throw new Error(`Invalid session manifest (chunk codec): ${id}`);
    }
    if (typeof entry.label !== 'string') {
      throw new Error(`Invalid session manifest (chunk label): ${id}`);
    }
    if (typeof entry.datasetDependent !== 'boolean') {
      throw new Error(`Invalid session manifest (chunk datasetDependent): ${id}`);
    }
    if (typeof entry.storedBytes === 'number' && entry.storedBytes < 0) {
      throw new Error(`Invalid session manifest (chunk storedBytes): ${id}`);
    }
    if (typeof entry.uncompressedBytes === 'number' && entry.uncompressedBytes < 0) {
      throw new Error(`Invalid session manifest (chunk uncompressedBytes): ${id}`);
    }
  }
}

/**
 * Encode a JSON payload into UTF-8 bytes.
 * @param {any} value
 * @returns {Uint8Array}
 */
function encodeJsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Decode UTF-8 JSON bytes.
 * @param {Uint8Array} bytes
 * @returns {any}
 */
function decodeJsonBytes(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class SessionSerializer {
  /**
   * @param {object} options
   * @param {import('../state/core/data-state.js').DataState} options.state
   * @param {object} options.viewer
   * @param {HTMLElement|null} [options.sidebar]
   * @param {import('../../data/data-source-manager.js').DataSourceManager|null} [options.dataSourceManager]
   * @param {any|null} [options.comparisonModule]
   * @param {any|null} [options.analysisWindowManager]
   * @param {SessionContributor[]} options.contributors
   */
  constructor(options) {
    this._base = {
      state: options.state,
      viewer: options.viewer,
      sidebar: options.sidebar || null,
      dataSourceManager: options.dataSourceManager || null,
      comparisonModule: options.comparisonModule || null,
      analysisWindowManager: options.analysisWindowManager || null
    };

    /** @type {SessionContributor[]} */
    this._contributors = Array.isArray(options.contributors) ? options.contributors : [];

    /** @type {Map<string, SessionContributor>} */
    this._contributorById = new Map();
    for (const c of this._contributors) {
      if (c?.id) this._contributorById.set(c.id, c);
    }

    /** @type {AbortController|null} */
    this._activeRestoreAbort = null;
    /** @type {Promise<void>|null} */
    this._activeLazyTask = null;
  }

  /**
   * Update the analysis module references once it is initialized.
   * This avoids hard coupling to `main.js` bootstrap order.
   *
   * @param {{ comparisonModule?: any, analysisWindowManager?: any }} refs
   */
  setAnalysisRefs(refs = {}) {
    if (refs.comparisonModule) this._base.comparisonModule = refs.comparisonModule;
    if (refs.analysisWindowManager) this._base.analysisWindowManager = refs.analysisWindowManager;
  }

  /**
   * Cancel any in-flight restore (especially lazy chunk processing).
   */
  cancelRestore() {
    try { this._activeRestoreAbort?.abort(); } catch { /* ignore */ }
    this._activeRestoreAbort = null;
    this._activeLazyTask = null;
  }

  /**
   * Create a `.cellucid-session` bundle Blob.
   * @returns {Promise<Blob>}
   */
  async createSessionBundle() {
    const ctx = buildSessionContext(this._base, { abortSignal: null });

    /** @type {SessionChunk[]} */
    const emittedChunks = [];
    for (const contributor of this._contributors) {
      try {
        const produced = await contributor.capture(ctx);
        if (Array.isArray(produced)) emittedChunks.push(...produced);
      } catch (err) {
        // Capture failures should not block other contributors.
        console.warn(`[SessionSerializer] Contributor capture failed (${contributor?.id}):`, err);
      }
    }

    // Writer invariant: all eager chunks must appear before any lazy chunks.
    // Preserve contributor-relative ordering within each priority bucket.
    /** @type {SessionChunk[]} */
    const eagerChunks = [];
    /** @type {SessionChunk[]} */
    const lazyChunks = [];
    for (const chunk of emittedChunks) {
      if (chunk?.priority === 'lazy') lazyChunks.push(chunk);
      else eagerChunks.push(chunk);
    }
    const orderedChunks = [...eagerChunks, ...lazyChunks];

    // Encode and (optionally) gzip each chunk payload into stored bytes.
    /** @type {any[]} */
    const manifestChunks = [];
    /** @type {Uint8Array[]} */
    const storedChunks = [];

    for (const chunk of orderedChunks) {
      if (!chunk) continue;
      if (typeof chunk.id !== 'string' || !chunk.id) throw new Error('Invalid chunk: missing id.');
      if (typeof chunk.contributorId !== 'string' || !chunk.contributorId) throw new Error(`Invalid chunk: missing contributorId (${chunk.id}).`);
      if (chunk.priority !== 'eager' && chunk.priority !== 'lazy') throw new Error(`Invalid chunk priority (${chunk.id}).`);
      if (chunk.kind !== 'json' && chunk.kind !== 'binary') throw new Error(`Invalid chunk kind (${chunk.id}).`);
      if (chunk.codec !== 'none' && chunk.codec !== 'gzip') throw new Error(`Invalid chunk codec (${chunk.id}).`);

      // Serialize payload to bytes.
      const uncompressedBytes =
        chunk.kind === 'json'
          ? encodeJsonBytes(chunk.payload)
          : (chunk.payload instanceof Uint8Array ? chunk.payload : null);

      if (!uncompressedBytes) {
        throw new Error(`Invalid chunk payload for ${chunk.id} (expected ${chunk.kind}).`);
      }

      // Apply codec.
      const storedBytes = chunk.codec === 'gzip'
        ? await gzipCompress(uncompressedBytes)
        : uncompressedBytes;

      storedChunks.push(storedBytes);

      manifestChunks.push({
        id: chunk.id,
        contributorId: chunk.contributorId,
        priority: chunk.priority,
        kind: chunk.kind,
        codec: chunk.codec,
        label: chunk.label || chunk.id,
        datasetDependent: chunk.datasetDependent === true,
        storedBytes: storedBytes.byteLength,
        uncompressedBytes: uncompressedBytes.byteLength,
        dependsOn: Array.isArray(chunk.dependsOn) ? chunk.dependsOn : undefined
      });
    }

    const manifest = {
      createdAt: new Date().toISOString(),
      dataSource: ctx.dataSourceManager?.getStateSnapshot?.() || null,
      datasetFingerprint: getDatasetFingerprint(ctx),
      summary: null,
      chunks: manifestChunks
    };

    return writeBundle({ manifest, chunks: storedChunks });
  }

  /**
   * Download a `.cellucid-session` bundle.
   * @param {string} [filename]
   */
  async downloadSession(filename = 'cellucid-session.cellucid-session') {
    const blob = await this.createSessionBundle();
    downloadBlob(blob, filename);
  }

  /**
   * Show a file picker and progressively restore a session bundle.
   *
   * Resolves after the eager stage completes. Lazy stage continues in the
   * background (unless canceled).
   *
   * @returns {Promise<boolean>} True if a file was selected and restore started.
   */
  async loadSessionFromFile() {
    const file = await this._pickSessionFile();
    if (!file) return false;
    await this.restoreFromBlob(file);
    return true;
  }

  /**
   * Restore a session from a Blob/File.
   * Resolves after eager chunks complete; lazy continues in background.
   *
   * @param {Blob} blob
   * @returns {Promise<void>}
   */
  async restoreFromBlob(blob) {
    const totalBytes = typeof blob?.size === 'number' ? blob.size : null;
    await this._restoreFromBundleSource(blob, { totalBytes });
  }

  /**
   * Restore a session from a URL (fetch + streaming decode).
   * Resolves after eager chunks complete; lazy continues in background.
   *
   * @param {string} url
   * @param {{ cache?: RequestCache }} [options]
   * @returns {Promise<void>}
   */
  async restoreFromUrl(url, options = {}) {
    const target = String(url || '').trim();
    if (!target) throw new Error('restoreFromUrl: url is required.');

    // Cancel any in-flight restore so we never interleave chunk application.
    this.cancelRestore();
    const abortController = new AbortController();
    this._activeRestoreAbort = abortController;

    const ctx = buildSessionContext(this._base, { abortSignal: abortController.signal });
    const notifications = ctx.notifications;

    // Start an indeterminate "download" immediately; we'll upgrade to progress if we
    // learn a Content-Length after the fetch response headers arrive.
    const downloadId = notifications.startDownload('Loading session', null, {
      onCancel: () => {
        try { abortController.abort(); } catch { /* ignore */ }
      }
    });

    try {
      const fetchFn = typeof ctx?.dataSourceManager?.fetch === 'function'
        ? ctx.dataSourceManager.fetch.bind(ctx.dataSourceManager)
        : fetch;

      const res = await fetchFn(target, {
        signal: abortController.signal,
        cache: options.cache || 'no-store'
      });
      if (!res?.ok) {
        throw new Error(`Failed to fetch session (${res?.status || 'unknown'}): ${res?.statusText || target}`);
      }
      if (!res.body || typeof res.body.getReader !== 'function') {
        throw new Error('restoreFromUrl: fetch response has no readable body stream.');
      }

      // NOTE:
      // `Content-Length` is not always reliable for streamed responses in browsers.
      // In particular, when servers apply `Content-Encoding` (gzip/br), browsers
      // transparently decode the body stream but `Content-Length` still reflects
      // the encoded byte length. Using it for strict EOF/bounds checks can cause
      // false "truncated" errors (e.g., "Invalid chunk length ... > remaining ...").
      //
      // We treat it as a progress hint only, and rely on actual stream EOF to
      // detect truncation/corruption.
      const contentEncoding = String(res.headers?.get?.('Content-Encoding') || '').trim().toLowerCase();
      const lenHeader = res.headers?.get?.('Content-Length') || null;
      const totalBytesHint = lenHeader != null ? Number(lenHeader) : null;
      const hasReliableContentLength = !contentEncoding || contentEncoding === 'identity';

      const totalBytesForUi = (hasReliableContentLength && Number.isFinite(totalBytesHint) && totalBytesHint > 0)
        ? totalBytesHint
        : null;

      if (totalBytesForUi != null) {
        try { notifications.updateDownload(downloadId, 0, totalBytesForUi); } catch { /* ignore */ }
      }

      // Present a Blob-like interface to the bundle reader so it can enforce
      // file-length bounds when the stream length is reliable.
      const source = {
        // Only provide a trusted size when the response is not content-encoded.
        // For encoded responses, providing a size can break bundle parsing.
        size: totalBytesForUi != null ? totalBytesForUi : undefined,
        stream: () => res.body
      };

      await this._restoreFromBundleSource(source, {
        totalBytes: totalBytesForUi,
        notificationsOverride: notifications,
        downloadIdOverride: downloadId,
        abortControllerOverride: abortController
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        try { notifications.failDownload(downloadId, 'Session restore canceled.'); } catch { /* ignore */ }
        return;
      }
      const msg = String(err?.message || err || 'unknown error');
      try { notifications.failDownload(downloadId, msg); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Restore the latest session bundle listed in `state-snapshots.json` under the
   * current dataset exports directory.
   *
   * This preserves the legacy "auto-load from exports" workflow, but the files
   * are now `.cellucid-session` bundles instead of JSON snapshots.
   *
   * @param {{ cache?: RequestCache }} [options]
   * @returns {Promise<boolean>} True when a bundle was found and restore started.
   */
  async restoreLatestFromDatasetExports(options = {}) {
    const urls = await this.listDatasetSessionBundles(options);
    if (!urls.length) return false;
    const target = urls[urls.length - 1];
    await this.restoreFromUrl(target, options);
    return true;
  }

  /**
   * List session bundles in the current dataset exports directory.
   *
   * Reads `state-snapshots.json` (manifest) if present and returns resolved URLs
   * for `.cellucid-session` entries.
   *
   * @param {{ cache?: RequestCache }} [options]
   * @returns {Promise<string[]>}
   */
  async listDatasetSessionBundles(options = {}) {
    const dsm = this._base.dataSourceManager;
    const baseUrlRaw = dsm?.getCurrentBaseUrl?.() || null;
    if (!baseUrlRaw) {
      console.warn('[SessionSerializer] Auto-load skipped: no dataset base URL (no active dataset?).');
      return [];
    }

    const fetchFn = typeof dsm?.fetch === 'function' ? dsm.fetch.bind(dsm) : fetch;

    // Resolve `state-snapshots.json` robustly even when `baseUrlRaw` is relative or
    // lacks a trailing slash.
    let manifestUrl = null;
    try {
      const base = new URL(
        String(baseUrlRaw),
        typeof window !== 'undefined' ? window.location?.href : undefined
      );
      if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
      manifestUrl = new URL('state-snapshots.json', base).toString();
    } catch {
      const baseUrl = String(baseUrlRaw);
      const baseWithSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
      manifestUrl = `${baseWithSlash}state-snapshots.json`;
    }

    /** @type {string[]} */
    const candidates = [manifestUrl];

    let res = null;
    let payload = null;

    for (const candidateUrl of candidates) {
      res = null;
      payload = null;
      try {
        res = await fetchFn(candidateUrl, { cache: options.cache || 'no-store' });
      } catch (err) {
        console.warn('[SessionSerializer] Failed to fetch state-snapshots.json:', candidateUrl, err);
        continue;
      }

      if (!res?.ok) {
        console.warn('[SessionSerializer] state-snapshots.json not available:', {
          url: candidateUrl,
          resolvedUrl: res?.url || null,
          status: res?.status,
          statusText: res?.statusText
        });
        continue;
      }

      try {
        // Read as text so we can report useful diagnostics when JSON parsing fails.
        const text = await res.text();
        payload = JSON.parse(text);
        manifestUrl = candidateUrl;
        break;
      } catch (err) {
        const contentType = res.headers?.get?.('Content-Type') || null;
        console.warn('[SessionSerializer] Failed to parse state-snapshots.json (expected JSON):', {
          url: candidateUrl,
          resolvedUrl: res.url || null,
          contentType,
          error: err
        });
        continue;
      }
    }

    if (!payload || !res) return [];

    const entries = Array.isArray(payload)
      ? payload
      : payload?.states || payload?.files || payload?.snapshots || [];
    if (!Array.isArray(entries) || entries.length === 0) {
      console.warn('[SessionSerializer] state-snapshots.json has no entries:', {
        url: manifestUrl,
        resolvedUrl: res.url || null
      });
      return [];
    }

    /** @type {string[]} */
    const out = [];
    const seen = new Set();

    // Prefer the fetch-resolved response URL (handles redirects). Fall back to
    // the computed manifest URL.
    const baseForResolve = String(res?.url || manifestUrl);

    for (const entry of entries) {
      const entryPath = typeof entry === 'string'
        ? entry
        : entry?.url || entry?.path || entry?.href || entry?.file || entry?.filename || entry?.name;
      if (!entryPath) continue;

      const entryText = String(entryPath).trim();
      if (!entryText) continue;

      const entrySansQuery = entryText.split('?')[0].split('#')[0];
      const filename = entrySansQuery.split('/').pop() || '';
      if (!/\.cellucid-session$/i.test(filename)) continue;

      let abs = null;
      try {
        abs = new URL(entryText, baseForResolve).toString();
      } catch {
        abs = entryText;
      }

      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    }

    if (out.length === 0) {
      console.warn('[SessionSerializer] state-snapshots.json contained no .cellucid-session entries:', {
        url: manifestUrl,
        resolvedUrl: res.url || null,
        entryCount: entries.length
      });
    }

    return out;
  }

  /**
   * Shared restore implementation for any bundle source (Blob/File or a
   * Blob-like `{ size, stream() }` object).
   *
   * @param {any} source
   * @param {{ totalBytes?: number|null, notificationsOverride?: any, downloadIdOverride?: string|null, abortControllerOverride?: AbortController|null }} [options]
   * @returns {Promise<void>}
   */
  async _restoreFromBundleSource(source, options = {}) {
    const abortController = options.abortControllerOverride || new AbortController();
    // Cancel any in-flight restore so we never interleave chunk application.
    // If the caller provided an AbortController, only cancel when it differs
    // from the current active controller (otherwise we'd abort ourselves).
    if (this._activeRestoreAbort && this._activeRestoreAbort !== abortController) {
      this.cancelRestore();
    }
    this._activeRestoreAbort = abortController;

    const ctx = buildSessionContext(this._base, { abortSignal: abortController.signal });
    const notifications = options.notificationsOverride || ctx.notifications;

    // Progress UI: treat the session file as a "download" so we can reuse the
    // existing progress + speed UI in NotificationCenter.
    const totalBytes = typeof options.totalBytes === 'number'
      ? options.totalBytes
      : (typeof source?.size === 'number' ? source.size : null);

    const downloadId = options.downloadIdOverride || notifications.startDownload('Loading session', totalBytes, {
      onCancel: () => {
        try { abortController.abort(); } catch { /* ignore */ }
      }
    });

    try {
      const { manifest, chunkStream } = await readBundle(source, {
        signal: abortController.signal,
        onProgress: (loaded) => {
          try { notifications.updateDownload(downloadId, loaded, totalBytes); } catch { /* ignore */ }
        }
      });

      validateManifest(manifest);

      const currentFp = getDatasetFingerprint(ctx);
      const fileFp = manifest.datasetFingerprint;
      const datasetMatches = datasetFingerprintMatches(fileFp, currentFp);

      if (!datasetMatches) {
        const saved = `${fileFp?.sourceType || 'unknown'}:${fileFp?.datasetId || 'unknown'}`;
        const current = `${currentFp?.sourceType || 'unknown'}:${currentFp?.datasetId || 'unknown'}`;
        notifications.warning(
          `Session dataset mismatch (${saved} ≠ ${current}). Restoring only dataset-agnostic layout.`,
          { category: 'session' }
        );
      }

      // Phase split: apply eager chunks now, then continue lazy in the background.
      const iterator = chunkStream[Symbol.asyncIterator]();

      // Helper that decodes a chunk payload and dispatches to its contributor.
      const applyChunk = async (meta, storedBytes) => {
        throwIfAborted(abortController.signal);

        if (!meta || typeof meta !== 'object') return;
        if (!datasetMatches && meta.datasetDependent === true) return; // skip dataset-dependent chunks on mismatch

        const contributor = this._contributorById.get(meta.contributorId) || null;
        if (!contributor) {
          console.warn(`[SessionSerializer] No contributor registered for '${meta.contributorId}'. Skipping chunk '${meta.id}'.`);
          return;
        }

        // Decode codec.
        // NOTE: `uncompressedBytes` comes from an untrusted file. Treat it as a
        // hint and always enforce a hard cap to avoid zip-bomb allocations.
        const declaredUncompressedBytes =
          typeof meta.uncompressedBytes === 'number' ? meta.uncompressedBytes : null;
        const maxOut = declaredUncompressedBytes != null
          ? Math.min(declaredUncompressedBytes, DEFAULT_MAX_UNCOMPRESSED_CHUNK_BYTES)
          : DEFAULT_MAX_UNCOMPRESSED_CHUNK_BYTES;

        let decodedBytes = null;
        if (meta.codec === 'gzip') {
          decodedBytes = await gzipDecompress(storedBytes, { maxOutputBytes: maxOut, signal: abortController.signal });
        } else {
          // For uncompressed chunks, enforce the same guard (large sessions should gzip + chunk).
          if (storedBytes.byteLength > maxOut) {
            throw new Error(`Chunk '${meta.id}' exceeds size limit (${storedBytes.byteLength} > ${maxOut} bytes).`);
          }
          decodedBytes = storedBytes;
        }

        // Decode kind.
        const payload = meta.kind === 'json' ? decodeJsonBytes(decodedBytes) : decodedBytes;

        try {
          await contributor.restore(ctx, meta, payload);
        } catch (err) {
          // Chunk failures should not brick the session; isolate errors.
          console.warn(`[SessionSerializer] Failed to restore chunk '${meta.id}' (${meta.contributorId}):`, err);
        }
      };

      // EAGER stage: process until the first lazy chunk (or EOF).
      let firstLazy = null;
      while (true) {
        throwIfAborted(abortController.signal);
        const { value, done } = await iterator.next();
        if (done) break;
        const meta = value?.meta;
        if (meta?.priority === 'lazy') {
          firstLazy = value;
          break;
        }
        await applyChunk(meta, value.bytes);
      }

      // Lazy stage in background (if any).
      if (firstLazy) {
        const lazyTask = (async () => {
          try {
            await applyChunk(firstLazy.meta, firstLazy.bytes);
            // Process remaining chunks one at a time, yielding between chunks.
            while (true) {
              throwIfAborted(abortController.signal);
              const { value, done } = await iterator.next();
              if (done) break;
              await nextTick();
              await applyChunk(value.meta, value.bytes);
            }
          } finally {
            // Completion is handled by the outer try/catch/finally below.
          }
        })();
        this._activeLazyTask = lazyTask;

        lazyTask.finally(() => {
          // Clear only if this restore is still the active one (avoid clobbering
          // state for a newer restore).
          if (this._activeLazyTask === lazyTask) this._activeLazyTask = null;
          if (this._activeRestoreAbort === abortController) this._activeRestoreAbort = null;
        });
      } else {
        this._activeLazyTask = null;
      }

      // Eager stage is done; allow UI refresh callbacks to run immediately.
      notifications.info('Session restored (eager stage complete).', { category: 'session', duration: 2200 });

      // Wait for lazy stage to finish only for progress completion; do not block the caller.
      const lazyTask = this._activeLazyTask;
      if (lazyTask) {
        lazyTask.then(
          () => {
            try { notifications.completeDownload(downloadId, 'Session fully restored.'); } catch { /* ignore */ }
          },
          (err) => {
            if (err?.name === 'AbortError') {
              try { notifications.failDownload(downloadId, 'Session restore canceled.'); } catch { /* ignore */ }
            } else {
              const msg = String(err?.message || err || 'unknown error');
              try { notifications.failDownload(downloadId, `Session restore failed: ${msg}`); } catch { /* ignore */ }
            }
          }
        );
      } else {
        // No lazy stage: the entire file has been consumed already.
        try { notifications.completeDownload(downloadId, 'Session fully restored.'); } catch { /* ignore */ }
        if (this._activeRestoreAbort === abortController) this._activeRestoreAbort = null;
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        try { notifications.failDownload(downloadId, 'Session restore canceled.'); } catch { /* ignore */ }
        if (this._activeRestoreAbort === abortController) this._activeRestoreAbort = null;
        return;
      }
      const msg = String(err?.message || err || 'unknown error');
      try { notifications.failDownload(downloadId, msg); } catch { /* ignore */ }
      if (this._activeRestoreAbort === abortController) this._activeRestoreAbort = null;
      throw err;
    }
  }

  /**
   * Open a file picker for `.cellucid-session` files.
   * @returns {Promise<File|null>}
   */
  async _pickSessionFile() {
    // Prefer the File System Access API when available because it provides a
    // reliable cancellation signal (rejects with AbortError).
    if (typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function') {
      try {
        const handles = await window.showOpenFilePicker({
          multiple: false,
          types: [
            {
              description: 'Cellucid session bundle',
              accept: { 'application/octet-stream': ['.cellucid-session'] }
            }
          ]
        });
        const handle = Array.isArray(handles) ? handles[0] : null;
        if (!handle?.getFile) return null;
        return await handle.getFile();
      } catch (err) {
        if (err?.name === 'AbortError') return null;
        throw err;
      }
    }

    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.cellucid-session,application/octet-stream';
      input.style.position = 'fixed';
      input.style.left = '-10000px';
      input.style.top = '0';
      input.style.opacity = '0';
      document.body.appendChild(input);

      let settled = false;
      const cleanup = () => {
        try { input.remove(); } catch { /* ignore */ }
      };

      const settle = (file) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(file);
      };

      // Standard selection path.
      input.addEventListener('change', (e) => {
        const file = e.target?.files?.[0] || null;
        settle(file);
      }, { once: true });

      // Some browsers support `cancel` on file inputs.
      input.addEventListener?.('cancel', () => settle(null), { once: true });
      input.oncancel = () => settle(null);

      // Best-effort cancellation: when the picker closes without a selection,
      // `change` doesn't fire. When focus returns, settle with null.
      window.addEventListener('focus', () => {
        // Some browsers update `input.files` after focus returns, but before
        // dispatching `change`. Poll briefly to avoid settling null too early.
        const maxChecks = 25;
        const intervalMs = 80;
        let checks = 0;

        const poll = () => {
          if (settled) return;
          const file = input.files?.[0] || null;
          if (file) {
            settle(file);
            return;
          }
          checks += 1;
          if (checks >= maxChecks) {
            settle(null);
            return;
          }
          setTimeout(poll, intervalMs);
        };

        setTimeout(poll, 0);
      }, { once: true });

      input.click();
    });
  }
}
