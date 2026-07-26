/**
 * @fileoverview Session bundle orchestrator.
 *
 * Responsibilities (per session-serializer-plan.md):
 * - enumerate contributors in a fixed order
 * - capture chunks + write a single-file `.cellucid-session` bundle
 * - load manifest and apply eager/lazy chunks in one awaited restore operation
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
  MAX_UNCOMPRESSED_CHUNK_BYTES,
  MAX_STORED_CHUNK_BYTES
} from './bundle/format.js';
import { gzipCompress, gzipDecompress } from './codecs/gzip.js';
import {
  buildSessionContext,
  createSessionRestoreTransaction,
  datasetFingerprintMatches,
  getDatasetFingerprint
} from './session-context.js';
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainRecord,
  assertSafeInteger,
  requireMethod
} from './schema-contract.js';

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
  if (signal !== null && signal.aborted) {
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
function validateManifest(manifest, contributorById) {
  assertExactKeys(
    manifest,
    ['createdAt', 'datasetFingerprint', 'chunks'],
    'Session manifest'
  );
  if (
    typeof manifest.createdAt !== 'string'
    || new Date(manifest.createdAt).toISOString() !== manifest.createdAt
  ) {
    throw new TypeError('Session manifest createdAt must be a canonical ISO timestamp.');
  }
  datasetFingerprintMatches(
    manifest.datasetFingerprint,
    manifest.datasetFingerprint
  );
  assertArray(manifest.chunks, 'Session manifest chunks');
  const chunkIds = new Set();
  let sawLazy = false;
  for (let index = 0; index < manifest.chunks.length; index++) {
    const entry = manifest.chunks[index];
    const context = `Session manifest chunk ${index}`;
    assertExactKeys(
      entry,
      [
        'id',
        'contributorId',
        'priority',
        'kind',
        'codec',
        'label',
        'datasetDependent',
        'storedBytes',
        'uncompressedBytes'
      ],
      context
    );
    const chunkId = assertNonEmptyString(entry.id, `${context} id`);
    if (chunkIds.has(chunkId)) {
      throw new TypeError(`Session manifest chunk id "${chunkId}" is duplicated.`);
    }
    chunkIds.add(chunkId);
    const contributorId = assertNonEmptyString(
      entry.contributorId,
      `${context} contributorId`
    );
    if (!contributorById.has(contributorId)) {
      throw new Error(
        `Session contributor "${contributorId}" is not registered for chunk "${chunkId}".`
      );
    }
    if (entry.priority !== 'eager' && entry.priority !== 'lazy') {
      throw new TypeError(`${context} priority must be eager or lazy.`);
    }
    if (entry.priority === 'lazy') {
      sawLazy = true;
    } else if (sawLazy) {
      throw new TypeError('Session manifest eager chunks must precede lazy chunks.');
    }
    if (entry.kind !== 'json' && entry.kind !== 'binary') {
      throw new TypeError(`${context} kind must be json or binary.`);
    }
    if (entry.codec !== 'none' && entry.codec !== 'gzip') {
      throw new TypeError(`${context} codec must be none or gzip.`);
    }
    assertNonEmptyString(entry.label, `${context} label`);
    assertBoolean(entry.datasetDependent, `${context} datasetDependent`);
    assertSafeInteger(entry.storedBytes, `${context} storedBytes`, {
      maximum: MAX_STORED_CHUNK_BYTES
    });
    assertSafeInteger(entry.uncompressedBytes, `${context} uncompressedBytes`, {
      maximum: MAX_UNCOMPRESSED_CHUNK_BYTES
    });
  }
  return manifest;
}

function assertJsonValue(value, context, ancestors = new Set()) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${context} JSON numbers must be finite.`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${context} must contain only exact JSON values.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${context} must not contain cyclic references.`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`${context} arrays must not contain holes.`);
      }
      assertJsonValue(value[index], `${context}[${index}]`, ancestors);
    }
  } else {
    assertPlainRecord(value, context);
    for (const [key, child] of Object.entries(value)) {
      assertNonEmptyString(key, `${context} property name`);
      assertJsonValue(child, `${context}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
  return value;
}

/**
 * Encode a JSON payload into UTF-8 bytes.
 * @param {any} value
 * @returns {Uint8Array}
 */
function encodeJsonBytes(value) {
  assertJsonValue(value, 'Session JSON payload');
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Decode UTF-8 JSON bytes.
 * @param {Uint8Array} bytes
 * @returns {any}
 */
function decodeJsonBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Session JSON bytes must be a Uint8Array.');
  }
  const value = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  );
  return assertJsonValue(value, 'Decoded session JSON payload');
}

function assertOwner(value, context) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${context} must be an object.`);
  }
  return value;
}

function assertNullableOwner(value, context) {
  if (value === null) return value;
  return assertOwner(value, context);
}

function assertAbortController(value, context) {
  assertOwner(value, context);
  requireMethod(value, 'abort', context);
  if (
    value.signal === null
    || typeof value.signal !== 'object'
    || typeof value.signal.aborted !== 'boolean'
  ) {
    throw new TypeError(`${context} must expose an AbortSignal.`);
  }
  return value;
}

function assertNotifications(value) {
  assertOwner(value, 'Session notification owner');
  for (const methodName of [
    'startDownload',
    'updateDownload',
    'completeDownload',
    'failDownload',
    'info'
  ]) {
    requireMethod(value, methodName, 'Session notification owner');
  }
  return value;
}

function assertCapturedChunk(chunk, contributorId, chunkIds) {
  const context = `Session contributor "${contributorId}" chunk`;
  assertExactKeys(
    chunk,
    [
      'id',
      'contributorId',
      'priority',
      'kind',
      'codec',
      'label',
      'datasetDependent',
      'payload'
    ],
    context
  );
  const chunkId = assertNonEmptyString(chunk.id, `${context} id`);
  if (chunkIds.has(chunkId)) {
    throw new TypeError(`Session chunk id "${chunkId}" is duplicated.`);
  }
  chunkIds.add(chunkId);
  if (chunk.contributorId !== contributorId) {
    throw new TypeError(
      `${context} contributorId must equal its current contributor id.`
    );
  }
  if (chunk.priority !== 'eager' && chunk.priority !== 'lazy') {
    throw new TypeError(`${context} priority must be eager or lazy.`);
  }
  if (chunk.kind !== 'json' && chunk.kind !== 'binary') {
    throw new TypeError(`${context} kind must be json or binary.`);
  }
  if (chunk.codec !== 'none' && chunk.codec !== 'gzip') {
    throw new TypeError(`${context} codec must be none or gzip.`);
  }
  assertNonEmptyString(chunk.label, `${context} label`);
  assertBoolean(chunk.datasetDependent, `${context} datasetDependent`);
  if (chunk.kind === 'json') {
    assertJsonValue(chunk.payload, `${context} payload`);
  } else if (!(chunk.payload instanceof Uint8Array)) {
    throw new TypeError(`${context} binary payload must be a Uint8Array.`);
  }
  return chunk;
}

function failureMessage(error) {
  if (!(error instanceof Error)) {
    return 'Session operation threw a non-Error value.';
  }
  if (typeof error.message !== 'string' || error.message.length === 0) {
    return error.name;
  }
  return error.message;
}

function preserveRestoreRollbackFailure(error, rollbackError) {
  if (error instanceof Error && error.cause === undefined) {
    error.cause = rollbackError;
  }
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
    assertExactKeys(
      options,
      [
        'state',
        'viewer',
        'sidebar',
        'dataSourceManager',
        'comparisonModule',
        'analysisWindowManager',
        'cinematicCamera',
        'contributors'
      ],
      'SessionSerializer options'
    );
    this._base = {
      state: assertOwner(options.state, 'SessionSerializer state'),
      viewer: assertOwner(options.viewer, 'SessionSerializer viewer'),
      sidebar: assertOwner(options.sidebar, 'SessionSerializer sidebar'),
      dataSourceManager: assertNullableOwner(
        options.dataSourceManager,
        'SessionSerializer dataSourceManager'
      ),
      comparisonModule: assertNullableOwner(
        options.comparisonModule,
        'SessionSerializer comparisonModule'
      ),
      analysisWindowManager: assertNullableOwner(
        options.analysisWindowManager,
        'SessionSerializer analysisWindowManager'
      ),
      cinematicCamera: assertNullableOwner(
        options.cinematicCamera,
        'SessionSerializer cinematicCamera'
      )
    };

    /** @type {SessionContributor[]} */
    this._contributors = assertArray(
      options.contributors,
      'SessionSerializer contributors'
    );

    /** @type {Map<string, SessionContributor>} */
    this._contributorById = new Map();
    for (let index = 0; index < this._contributors.length; index++) {
      const contributor = assertOwner(
        this._contributors[index],
        `Session contributor ${index}`
      );
      const contributorId = assertNonEmptyString(
        contributor.id,
        `Session contributor ${index} id`
      );
      requireMethod(contributor, 'capture', `Session contributor "${contributorId}"`);
      requireMethod(contributor, 'restore', `Session contributor "${contributorId}"`);
      if (this._contributorById.has(contributorId)) {
        throw new TypeError(`Session contributor id "${contributorId}" is duplicated.`);
      }
      this._contributorById.set(contributorId, contributor);
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
   * @param {{ comparisonModule: object, analysisWindowManager: object }} refs
   */
  setAnalysisRefs(refs) {
    assertExactKeys(
      refs,
      ['comparisonModule', 'analysisWindowManager'],
      'Session analysis references'
    );
    this._base.comparisonModule = assertOwner(
      refs.comparisonModule,
      'Session comparisonModule'
    );
    this._base.analysisWindowManager = assertOwner(
      refs.analysisWindowManager,
      'Session analysisWindowManager'
    );
  }

  /**
   * Set the cinematic camera reference once the UI is initialized.
   * @param {object} cinematicCamera
   */
  setCinematicCameraRef(cinematicCamera) {
    this._base.cinematicCamera = assertOwner(
      cinematicCamera,
      'Session cinematic camera'
    );
  }

  /**
   * Cancel any in-flight restore (especially lazy chunk processing).
   */
  cancelRestore() {
    if (this._activeRestoreAbort !== null) {
      this._activeRestoreAbort.abort();
    }
    this._activeRestoreAbort = null;
    this._activeLazyTask = null;
  }

  /**
   * Create a `.cellucid-session` bundle Blob.
   * @returns {Promise<Blob>}
   */
  async createSessionBundle() {
    const ctx = buildSessionContext(this._base, {
      abortSignal: null,
      restoreTransaction: null
    });

    /** @type {SessionChunk[]} */
    const emittedChunks = [];
    const emittedChunkIds = new Set();
    for (const contributor of this._contributors) {
      const produced = await contributor.capture(ctx);
      if (!Array.isArray(produced)) {
        throw new TypeError(
          `Session contributor "${contributor.id}" capture() must return an array`
        );
      }
      for (const chunk of produced) {
        emittedChunks.push(
          assertCapturedChunk(chunk, contributor.id, emittedChunkIds)
        );
      }
    }

    // Writer invariant: all eager chunks must appear before any lazy chunks.
    // Preserve contributor-relative ordering within each priority bucket.
    /** @type {SessionChunk[]} */
    const eagerChunks = [];
    /** @type {SessionChunk[]} */
    const lazyChunks = [];
    for (const chunk of emittedChunks) {
      if (chunk.priority === 'lazy') lazyChunks.push(chunk);
      else eagerChunks.push(chunk);
    }
    const orderedChunks = [...eagerChunks, ...lazyChunks];

    // Encode and (optionally) gzip each chunk payload into stored bytes.
    /** @type {any[]} */
    const manifestChunks = [];
    /** @type {Uint8Array[]} */
    const storedChunks = [];

    for (const chunk of orderedChunks) {
      // Serialize payload to bytes.
      const uncompressedBytes =
        chunk.kind === 'json'
          ? encodeJsonBytes(chunk.payload)
          : chunk.payload;
      if (uncompressedBytes.byteLength > MAX_UNCOMPRESSED_CHUNK_BYTES) {
        throw new RangeError(
          `Session chunk "${chunk.id}" exceeds the uncompressed byte limit.`
        );
      }

      // Apply codec.
      const storedBytes = chunk.codec === 'gzip'
        ? await gzipCompress(uncompressedBytes, { signal: null })
        : uncompressedBytes;
      if (storedBytes.byteLength > MAX_STORED_CHUNK_BYTES) {
        throw new RangeError(
          `Session chunk "${chunk.id}" exceeds the stored byte limit.`
        );
      }

      storedChunks.push(storedBytes);

      manifestChunks.push({
        id: chunk.id,
        contributorId: chunk.contributorId,
        priority: chunk.priority,
        kind: chunk.kind,
        codec: chunk.codec,
        label: chunk.label,
        datasetDependent: chunk.datasetDependent,
        storedBytes: storedBytes.byteLength,
        uncompressedBytes: uncompressedBytes.byteLength
      });
    }

    const manifest = {
      createdAt: new Date().toISOString(),
      datasetFingerprint: getDatasetFingerprint(ctx),
      chunks: manifestChunks
    };

    validateManifest(manifest, this._contributorById);
    return writeBundle({ manifest, chunks: storedChunks });
  }

  /**
   * Download a `.cellucid-session` bundle.
   * @param {string} filename
   */
  async downloadSession(filename) {
    assertNonEmptyString(filename, 'Session download filename');
    const blob = await this.createSessionBundle();
    downloadBlob(blob, filename);
  }

  /**
   * Show a file picker and progressively restore a session bundle.
   *
   * Resolves only after every selected session chunk has been restored.
   *
   * @returns {Promise<boolean>} True if a file was selected and restore started.
   */
  async loadSessionFromFile() {
    const file = await this._pickSessionFile();
    if (file === null) return false;
    await this.restoreFromBlob(file);
    return true;
  }

  /**
   * Restore a session from a Blob/File.
   * Resolves only after every selected session chunk has been restored.
   *
   * @param {Blob} blob
   * @returns {Promise<void>}
   */
  async restoreFromBlob(blob) {
    if (!(blob instanceof Blob)) {
      throw new TypeError('Session restore source must be a Blob or File.');
    }
    const totalBytes = assertSafeInteger(
      blob.size,
      'Session restore Blob size'
    );
    await this._restoreFromBundleSource(blob, {
      totalBytes,
      notifications: null,
      downloadId: null,
      abortController: null
    });
  }

  /**
   * Restore a session from a URL (fetch + streaming decode).
   * Resolves only after every selected session chunk has been restored.
   *
   * @param {string} url
   * @param {{ cache: RequestCache }} options
   * @returns {Promise<void>}
   */
  async restoreFromUrl(url, options) {
    const target = assertNonEmptyString(url, 'Session restore URL');
    assertExactKeys(options, ['cache'], 'Session URL restore options');
    const cacheModes = new Set([
      'default',
      'no-store',
      'reload',
      'no-cache',
      'force-cache',
      'only-if-cached'
    ]);
    if (!cacheModes.has(options.cache)) {
      throw new TypeError('Session URL restore cache mode is invalid.');
    }

    // Cancel any in-flight restore so we never interleave chunk application.
    this.cancelRestore();
    const abortController = new AbortController();
    this._activeRestoreAbort = abortController;

    const ctx = buildSessionContext(this._base, {
      abortSignal: abortController.signal,
      restoreTransaction: null
    });
    const notifications = assertNotifications(ctx.notifications);

    const downloadId = assertNonEmptyString(
      notifications.startDownload('Loading session', null, {
        onCancel: () => abortController.abort()
      }),
      'Session download notification id'
    );
    let delegatedToRestore = false;

    try {
      const fetchFn = requireMethod(
        ctx.dataSourceManager,
        'fetch',
        'Session URL restore data source manager'
      ).bind(ctx.dataSourceManager);
      const res = await fetchFn(target, {
        signal: abortController.signal,
        cache: options.cache
      });
      assertOwner(res, 'Session URL response');
      if (res.ok !== true) {
        assertSafeInteger(res.status, 'Session URL response status', {
          minimum: 100,
          maximum: 599
        });
        if (typeof res.statusText !== 'string') {
          throw new TypeError('Session URL response statusText must be a string.');
        }
        throw new Error(
          `Failed to fetch session (${res.status}): ${res.statusText}`
        );
      }
      if (
        res.body === null
        || typeof res.body !== 'object'
        || typeof res.body.getReader !== 'function'
      ) {
        throw new Error('restoreFromUrl: fetch response has no readable body stream.');
      }

      const source = {
        stream: () => res.body
      };
      delegatedToRestore = true;
      await this._restoreFromBundleSource(source, {
        totalBytes: null,
        notifications,
        downloadId,
        abortController
      });
    } catch (err) {
      if (!delegatedToRestore) {
        if (err instanceof Error && err.name === 'AbortError') {
          notifications.failDownload(downloadId, 'Session restore canceled.');
        } else {
          notifications.failDownload(downloadId, failureMessage(err));
        }
        if (this._activeRestoreAbort === abortController) {
          this._activeRestoreAbort = null;
        }
      }
      throw err;
    }
  }

  /**
   * Shared restore implementation for any bundle source (Blob/File or a
   * Blob-like `{ size, stream() }` object).
   *
   * @param {any} source
   * @param {{ totalBytes: number|null, notifications: object|null, downloadId: string|null, abortController: AbortController|null }} options
   * @returns {Promise<void>}
   */
  async _restoreFromBundleSource(source, options) {
    assertExactKeys(
      options,
      ['totalBytes', 'notifications', 'downloadId', 'abortController'],
      'Session restore options'
    );
    const totalBytes = options.totalBytes === null
      ? null
      : assertSafeInteger(options.totalBytes, 'Session restore totalBytes');
    const providedNotifications = options.notifications === null
      ? null
      : assertNotifications(options.notifications);
    const providedDownloadId = options.downloadId === null
      ? null
      : assertNonEmptyString(options.downloadId, 'Session download notification id');
    const abortController = options.abortController === null
      ? new AbortController()
      : assertAbortController(
        options.abortController,
        'Session restore AbortController'
      );

    if (
      this._activeRestoreAbort !== null
      && this._activeRestoreAbort !== abortController
    ) {
      this.cancelRestore();
    }
    this._activeRestoreAbort = abortController;

    const restoreTransaction = createSessionRestoreTransaction();
    const ctx = buildSessionContext(this._base, {
      abortSignal: abortController.signal,
      restoreTransaction
    });
    const notifications = providedNotifications === null
      ? assertNotifications(ctx.notifications)
      : providedNotifications;

    // Progress UI: treat the session file as a "download" so we can reuse the
    // existing progress + speed UI in NotificationCenter.
    const downloadId = providedDownloadId === null
      ? assertNonEmptyString(
        notifications.startDownload('Loading session', totalBytes, {
          onCancel: () => abortController.abort()
        }),
        'Session download notification id'
      )
      : providedDownloadId;

    try {
      const { manifest, chunkStream } = await readBundle(source, {
        signal: abortController.signal,
        onProgress: (loaded) =>
          notifications.updateDownload(downloadId, loaded, totalBytes)
      });

      validateManifest(manifest, this._contributorById);

      const currentFp = getDatasetFingerprint(ctx);
      const fileFp = manifest.datasetFingerprint;
      if (!datasetFingerprintMatches(fileFp, currentFp)) {
        throw new RangeError(
          'Session dataset mismatch: the complete saved dataset identity does not match the current dataset.'
        );
      }

      // Phase split: apply eager chunks now, then continue lazy in the background.
      const iterator = chunkStream[Symbol.asyncIterator]();

      // Helper that decodes a chunk payload and dispatches to its contributor.
      const applyChunk = async (meta, storedBytes) => {
        throwIfAborted(abortController.signal);
        assertPlainRecord(meta, 'Session restore chunk metadata');
        if (!(storedBytes instanceof Uint8Array)) {
          throw new TypeError('Session restore chunk bytes must be a Uint8Array.');
        }

        const contributor = this._contributorById.get(meta.contributorId);
        if (contributor === undefined) {
          throw new Error(
            `Session contributor "${meta.contributorId}" is not registered ` +
            `for chunk "${meta.id}"`
          );
        }

        let decodedBytes;
        if (meta.codec === 'gzip') {
          decodedBytes = await gzipDecompress(storedBytes, {
            maxOutputBytes: meta.uncompressedBytes,
            signal: abortController.signal
          });
        } else {
          decodedBytes = storedBytes;
        }
        if (decodedBytes.byteLength !== meta.uncompressedBytes) {
          throw new Error(
            `Session chunk "${meta.id}" uncompressed byte length does not match its manifest.`
          );
        }

        // Decode kind.
        const payload = meta.kind === 'json' ? decodeJsonBytes(decodedBytes) : decodedBytes;

        await contributor.restore(ctx, meta, payload);
      };

      // EAGER stage: process until the first lazy chunk (or EOF).
      let firstLazy = null;
      while (true) {
        throwIfAborted(abortController.signal);
        const { value, done } = await iterator.next();
        if (done) break;
        assertExactKeys(
          value,
          ['index', 'meta', 'bytes'],
          'Session streamed chunk'
        );
        assertSafeInteger(value.index, 'Session streamed chunk index');
        if (value.meta.priority === 'lazy') {
          firstLazy = value;
          break;
        }
        await applyChunk(value.meta, value.bytes);
      }

      // Apply the lazy stage in the same public restore operation. Yielding
      // between chunks keeps the browser responsive without creating a second
      // failure channel after restoreFromBlob()/restoreFromUrl() has resolved.
      if (firstLazy) {
        const lazyTask = (async () => {
          await applyChunk(firstLazy.meta, firstLazy.bytes);
          while (true) {
            throwIfAborted(abortController.signal);
            const { value, done } = await iterator.next();
            if (done) break;
            await nextTick();
            assertExactKeys(
              value,
              ['index', 'meta', 'bytes'],
              'Session streamed chunk'
            );
            assertSafeInteger(value.index, 'Session streamed chunk index');
            await applyChunk(value.meta, value.bytes);
          }
        })();
        this._activeLazyTask = lazyTask;
        try {
          await lazyTask;
        } finally {
          if (this._activeLazyTask === lazyTask) {
            this._activeLazyTask = null;
          }
        }
      } else {
        this._activeLazyTask = null;
      }

      restoreTransaction.commit();
      notifications.info('Session fully restored.', {
        category: 'session',
        duration: 2200
      });
      notifications.completeDownload(downloadId, 'Session fully restored.');
      if (this._activeRestoreAbort === abortController) {
        this._activeRestoreAbort = null;
      }
    } catch (err) {
      try {
        restoreTransaction.rollback();
      } catch (rollbackError) {
        preserveRestoreRollbackFailure(err, rollbackError);
      }
      if (err instanceof Error && err.name === 'AbortError') {
        notifications.failDownload(downloadId, 'Session restore canceled.');
      } else {
        notifications.failDownload(downloadId, failureMessage(err));
      }
      if (this._activeRestoreAbort === abortController) {
        this._activeRestoreAbort = null;
      }
      throw err;
    }
  }

  /**
   * Open a file picker for `.cellucid-session` files.
   * @returns {Promise<File|null>}
   */
  async _pickSessionFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = false;
      input.accept = '.cellucid-session,application/octet-stream';
      input.style.position = 'fixed';
      input.style.left = '-10000px';
      input.style.top = '0';
      input.style.opacity = '0';
      document.body.appendChild(input);

      let settled = false;
      const cleanup = () => {
        input.remove();
      };

      const settle = (file, error = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error !== null) reject(error);
        else resolve(file);
      };

      input.addEventListener('change', () => {
        if (input.files === null) {
          settle(null, new TypeError('Session file input did not publish a FileList.'));
          return;
        }
        if (input.files.length > 1) {
          settle(null, new TypeError('Session file input published more than one file.'));
          return;
        }
        settle(input.files.length === 1 ? input.files[0] : null);
      }, { once: true });

      input.addEventListener('cancel', () => settle(null), { once: true });

      input.click();
    });
  }
}
