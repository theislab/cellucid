/**
 * @fileoverview The published-default session profile, and the publish step.
 *
 * A Save State and a published `default.cellucid-session` are not the same
 * document. Save State writes every chunk the registered contributors emit —
 * seven for a session with nothing kept, more once a highlight group, a
 * user-defined field or an analysis artifact exists. `restorePublishedDefaultState()`
 * accepts exactly the five chunks of {@link PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE},
 * in that order, and refuses a cinematic chunk by name before anything else.
 *
 * Publishing a preset therefore means dropping `cinematic/camera` and
 * `analysis/cache-inventory` — and the drop is only lossless while both are
 * empty. A recorded camera path dropped from a save is gone: the export format
 * stores it nowhere else, and the published file that results still loads, so
 * nothing downstream ever notices. That precondition was checked by hand, once
 * (CEL-0248).
 *
 * This module is where the rule lives, so both halves are executable:
 *
 * - {@link assertPublishedDefaultChunkProfile} is the check, and it is the same
 *   function the reader runs. A test that calls it against a committed preset is
 *   asking the application itself, not a copy of its list.
 * - {@link trimToPublishedDefault} is the publish step. It drops what the
 *   profile has no room for and **refuses when a dropped chunk carries
 *   anything**, so the precondition is enforced instead of trusted.
 * - {@link rebindPublishedDefaultFingerprint} is the other half of publishing.
 *   A preset is captured against a local serve of the generation and read back
 *   as a catalog sample, and those are two identities; carrying the capture's
 *   through produces a file the reader refuses on every open. Publishing
 *   renames the capture, and verifies that it may.
 *
 * The droppable set is derived, not restated: it is
 * {@link CURRENT_GENERIC_STATIC_CHUNK_PROFILES} minus the published five. A
 * chunk outside the static profiles entirely — a highlight group's cell
 * membership, a user-defined field's codes, a cached analysis artifact — is user
 * content by construction and is never droppable, so the trim refuses it rather
 * than deciding whether it looks empty.
 *
 * @module session/published-default
 */

import { readBundle } from './bundle/reader.js';
import { writeBundle } from './bundle/writer.js';
import { gzipDecompress } from './codecs/gzip.js';
import {
  ANALYSIS_CACHE_INVENTORY_CHUNK_PROFILE
} from './contributors/analysis-artifacts.js';
import {
  assertArray,
  assertPlainRecord,
  assertSafeInteger
} from './schema-contract.js';
import { assertDatasetFingerprint } from './session-context.js';

/** Transport ceiling for a published default, before decompression. */
export const MAX_PUBLISHED_DEFAULT_STATE_BYTES = 32 * 1024;

/** Ceiling for a published default's chunks, per chunk and in aggregate. */
export const MAX_PUBLISHED_DEFAULT_UNCOMPRESSED_BYTES = 64 * 1024;

/**
 * The complete profile a published default may carry, in the accepted order.
 *
 * Every field is compared, not only the id: a preset that moved a payload to
 * another contributor, relabelled one, or stored one uncompressed is refused
 * before a contributor can mutate application state.
 */
export const PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE = Object.freeze([
  Object.freeze({
    id: 'core/field-overlays',
    contributorId: 'field-overlays',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Field overlays',
    datasetDependent: true
  }),
  Object.freeze({
    id: 'core/state',
    contributorId: 'core-state',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Core state',
    datasetDependent: true
  }),
  Object.freeze({
    id: 'ui/dockable-layout',
    contributorId: 'dockable-layout',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Floating panels',
    datasetDependent: false
  }),
  Object.freeze({
    id: 'analysis/windows',
    contributorId: 'analysis-windows',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Analysis windows',
    datasetDependent: true
  }),
  Object.freeze({
    id: 'highlights/meta',
    contributorId: 'highlights-meta',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Highlight metadata',
    datasetDependent: true
  })
]);

export const CINEMATIC_CAMERA_CHUNK_PROFILE = Object.freeze({
  id: 'cinematic/camera',
  contributorId: 'cinematic-camera',
  priority: 'eager',
  kind: 'json',
  codec: 'gzip',
  label: 'Cinematic camera path',
  datasetDependent: true
});

/** Every singleton chunk a current Save State emits. */
export const CURRENT_GENERIC_STATIC_CHUNK_PROFILES = Object.freeze([
  ...PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE,
  ANALYSIS_CACHE_INVENTORY_CHUNK_PROFILE,
  CINEMATIC_CAMERA_CHUNK_PROFILE
]);

export const STATIC_CHUNK_PROFILE_KEYS = Object.freeze([
  'id',
  'contributorId',
  'priority',
  'kind',
  'codec',
  'label',
  'datasetDependent'
]);

/**
 * The chunks publishing has to drop: every singleton a Save State emits that
 * the published profile has no room for.
 *
 * Derived rather than listed, so a third singleton chunk added to the session
 * becomes droppable here the day it lands — and, because the trim can only drop
 * a chunk it can prove empty, it becomes a *refusal* rather than a silent loss
 * until somebody decides what empty means for it.
 */
export const PUBLISHED_DEFAULT_DROPPED_CHUNK_PROFILES = Object.freeze(
  CURRENT_GENERIC_STATIC_CHUNK_PROFILES.filter(
    profile => !PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.includes(profile)
  )
);

const PUBLISHED_DEFAULT_PROFILE_MISMATCH =
  'Published default session must match the exact static profile.';

/**
 * Whether this manifest entry is cinematic camera data under any spelling.
 *
 * Matched on both the id namespace and the contributor, because either alone
 * would let a renamed chunk through.
 *
 * @param {any} entry
 * @returns {boolean}
 */
function isCinematicChunk(entry) {
  return (
    entry !== null
    && typeof entry === 'object'
    && (
      (
        typeof entry.id === 'string'
        && entry.id.startsWith('cinematic/')
      )
      || entry.contributorId === CINEMATIC_CAMERA_CHUNK_PROFILE.contributorId
    )
  );
}

/**
 * Assert that these manifest chunk records are exactly the published-default
 * profile, in the accepted order.
 *
 * This is the whole of what `restorePublishedDefaultState()` decides about
 * *which* chunks a published default carries; the byte ceilings around it are a
 * separate transport concern. Anything that wants to know whether a file will be
 * accepted calls this rather than comparing against a copy of the list.
 *
 * @param {any} chunks - `manifest.chunks` of a candidate published default.
 * @returns {any} The same array.
 */
export function assertPublishedDefaultChunkProfile(chunks) {
  if (!Array.isArray(chunks)) {
    throw new TypeError(PUBLISHED_DEFAULT_PROFILE_MISMATCH);
  }

  // Cinematic data is refused by name, ahead of the count, so that the one
  // chunk whose loss is unrecoverable produces its own sentence rather than a
  // generic "wrong shape".
  for (const entry of chunks) {
    if (isCinematicChunk(entry)) {
      throw new TypeError(
        'Published default session must not contain cinematic camera data.'
      );
    }
  }

  if (chunks.length !== PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.length) {
    throw new TypeError(PUBLISHED_DEFAULT_PROFILE_MISMATCH);
  }
  for (
    let index = 0;
    index < PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.length;
    index++
  ) {
    const actual = chunks[index];
    const expected = PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE[index];
    if (actual === null || typeof actual !== 'object') {
      throw new TypeError(PUBLISHED_DEFAULT_PROFILE_MISMATCH);
    }
    for (const key of STATIC_CHUNK_PROFILE_KEYS) {
      if (actual[key] !== expected[key]) {
        throw new TypeError(PUBLISHED_DEFAULT_PROFILE_MISMATCH);
      }
    }
  }
  return chunks;
}

/**
 * What this decoded payload value carries, or `null` when it carries nothing.
 *
 * A droppable chunk's payload is settings plus content: the settings are
 * primitives, and the content is whatever is collected in an array. Deciding
 * emptiness on the shape rather than on named keys is what lets this cover a
 * chunk nobody has written yet, and what makes an unexpected nested record a
 * refusal instead of a value the walk quietly skips.
 *
 * @param {any} value
 * @param {string} path
 * @returns {string|null}
 */
function describeRetainedContent(value, path) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return `${path} holds ${value.length} entr${value.length === 1 ? 'y' : 'ies'}`;
  }
  if (typeof value === 'object') {
    return `${path} is a nested record this publish step cannot prove empty`;
  }
  return `${path} is not a JSON value`;
}

/**
 * @param {any} payload
 * @param {string} chunkId
 * @returns {string|null} What the chunk would lose, or `null` when it is empty.
 */
function describeDroppedChunkLoss(payload, chunkId) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return `"${chunkId}" payload is not a JSON record`;
  }
  const losses = [];
  for (const [key, value] of Object.entries(payload)) {
    const retained = describeRetainedContent(value, `"${chunkId}" ${key}`);
    if (retained !== null) losses.push(retained);
  }
  return losses.length === 0 ? null : losses.join('; ');
}

/**
 * @param {{ meta: any, bytes: Uint8Array }} chunk
 * @returns {Promise<any>}
 */
async function decodeJsonChunkPayload(chunk) {
  const uncompressedBytes = assertSafeInteger(
    chunk.meta.uncompressedBytes,
    `Session chunk "${chunk.meta.id}" uncompressedBytes`,
    { maximum: MAX_PUBLISHED_DEFAULT_UNCOMPRESSED_BYTES }
  );
  const raw = chunk.meta.codec === 'gzip'
    ? await gzipDecompress(chunk.bytes, {
      maxOutputBytes: uncompressedBytes,
      signal: null
    })
    : chunk.bytes;
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
}

/**
 * The source type every published default is opened under.
 *
 * A published default is fetched from the generation's own directory, which
 * only an advertised catalog entry has — `assertDatasetStateDescriptor()` in
 * `dataset-state-manifest.js` refuses a descriptor of any other source type. So
 * this is not a default a caller may override: it is the only identity under
 * which the file this step writes is ever read.
 */
export const PUBLISHED_DEFAULT_SOURCE_TYPE = 'local-demo';

/**
 * The fingerprint fields that describe the data rather than name it.
 *
 * The split is the whole of the rebinding rule below: publishing may rename a
 * dataset and may never redescribe it.
 */
const DATASET_DESCRIBING_FINGERPRINT_FIELDS = Object.freeze([
  Object.freeze({
    read: fingerprint => fingerprint.cellCount,
    label: 'cell count'
  }),
  Object.freeze({
    read: fingerprint => fingerprint.varCount,
    label: 'gene count'
  }),
  Object.freeze({
    read: fingerprint => fingerprint.cellOrder.dimension,
    label: 'embedding dimension'
  }),
  Object.freeze({
    read: fingerprint => fingerprint.cellOrder.digest,
    label: 'cell-order digest'
  })
]);

/**
 * Bind a capture's fingerprint to the identity it will be published under.
 *
 * A preset is authored by opening the generation and framing a view, and the
 * natural way to do that is to serve the prepared directory locally. That
 * capture records the identity of the *serve* — `local-user`, and a dataset id
 * the local source made up — while the catalog serves the same bytes as
 * {@link PUBLISHED_DEFAULT_SOURCE_TYPE} under the generation's own id.
 * `datasetFingerprintMatches()` compares both fields, so a preset published with
 * the capture's identity can never match the dataset it ships beside: the file
 * is structurally valid, and the reader refuses it on identity every time the
 * sample is opened. Carrying the capture's identity through was how five
 * shipped presets came to refuse themselves.
 *
 * Renaming is safe only because the four describing fields are *verified*
 * rather than replaced. A mismatch means the capture was taken against
 * different data, and stamping the published name onto it would assert an
 * identity the bytes do not have — so it is refused, naming the field.
 *
 * `cellOrder.digest` is carried from the capture rather than recomputed: this
 * module never sees coordinates. What proves it is the digest of the *published*
 * coordinates is the publishing repository's own step, which recomputes it from
 * the generation's point payload before calling here.
 *
 * @param {any} captured - `manifest.datasetFingerprint` of the capture.
 * @param {any} published - The fingerprint the generation is served under.
 * @returns {object} The fingerprint the published default carries.
 */
export function rebindPublishedDefaultFingerprint(captured, published) {
  assertDatasetFingerprint(captured, 'Captured dataset fingerprint');
  assertDatasetFingerprint(published, 'Published dataset fingerprint');

  if (published.sourceType !== PUBLISHED_DEFAULT_SOURCE_TYPE) {
    throw new TypeError(
      `A published default is read as ${PUBLISHED_DEFAULT_SOURCE_TYPE}, so it `
      + `cannot be published as ${JSON.stringify(published.sourceType)}.`
    );
  }
  if (typeof published.datasetId !== 'string' || published.datasetId === '') {
    throw new TypeError(
      'A published default must name the generation it ships beside.'
    );
  }

  for (const field of DATASET_DESCRIBING_FINGERPRINT_FIELDS) {
    const capturedValue = field.read(captured);
    const publishedValue = field.read(published);
    if (capturedValue !== publishedValue) {
      throw new Error(
        `This capture cannot be published as "${published.datasetId}": it was `
        + `taken against data with a ${field.label} of `
        + `${JSON.stringify(capturedValue)}, and that generation publishes `
        + `${JSON.stringify(publishedValue)}. Publishing renames a capture; it `
        + 'cannot restate what the capture was taken against. Re-capture the '
        + 'view on the generation being published.'
      );
    }
  }

  return {
    sourceType: PUBLISHED_DEFAULT_SOURCE_TYPE,
    datasetId: published.datasetId,
    cellCount: captured.cellCount,
    varCount: captured.varCount,
    cellOrder: {
      dimension: captured.cellOrder.dimension,
      digest: captured.cellOrder.digest
    }
  };
}

/**
 * Turn a Save State into the published default it would become, or refuse.
 *
 * The refusal is the point. Publishing drops chunks, and a dropped chunk that
 * carried something is lost with no trace in the file that ships: the result
 * still loads, and the camera path the author recorded is simply not there. So
 * this drops only what it can prove empty, and names what it found otherwise.
 *
 * The same applies to identity, which is not a chunk and is just as invisible
 * when it is wrong — see {@link rebindPublishedDefaultFingerprint}.
 *
 * @param {Blob} source - A `.cellucid-session` written by Save State.
 * @param {object} publishedIdentity - The fingerprint the generation is served
 *   under, in the shape `getDatasetFingerprint()` produces.
 * @returns {Promise<Blob>} The publishable `default.cellucid-session`.
 */
export async function trimToPublishedDefault(source, publishedIdentity) {
  // Checked before the source is read, so a caller that omitted the identity is
  // told so instead of watching a trim succeed and produce an inert file.
  assertDatasetFingerprint(publishedIdentity, 'Published dataset fingerprint');

  // Fail closed: every droppable chunk must be one this step can inspect. A
  // singleton added to the session with a payload shape that is not JSON would
  // otherwise be dropped on the strength of never having been considered.
  for (const profile of PUBLISHED_DEFAULT_DROPPED_CHUNK_PROFILES) {
    if (profile.kind !== 'json') {
      throw new TypeError(
        `Publishing cannot drop "${profile.id}": its payload is `
        + `${profile.kind}, so this step cannot prove it carries nothing.`
      );
    }
  }

  const { manifest, chunkStream } = await readBundle(source, {
    signal: null,
    onProgress: null
  });
  assertPlainRecord(manifest, 'Session manifest');
  assertArray(manifest.chunks, 'Session manifest chunks');

  /** @type {{ meta: any, bytes: Uint8Array }[]} */
  const chunks = [];
  for await (const chunk of chunkStream) chunks.push(chunk);

  const keptById = new Map(
    PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.map(profile => [profile.id, profile])
  );
  const droppableById = new Map(
    PUBLISHED_DEFAULT_DROPPED_CHUNK_PROFILES.map(
      profile => [profile.id, profile]
    )
  );

  /** @type {{ meta: any, bytes: Uint8Array }[]} */
  const kept = [];
  for (const chunk of chunks) {
    const chunkId = chunk.meta?.id;
    if (keptById.has(chunkId)) {
      kept.push(chunk);
      continue;
    }
    const droppable = droppableById.get(chunkId);
    if (droppable === undefined) {
      throw new TypeError(
        `Publishing cannot drop "${chunkId}": it is not one of the chunks a `
        + 'published default leaves behind, so dropping it would discard '
        + 'content the file is the only copy of. Clear it in the application '
        + 'and capture the state again.'
      );
    }
    for (const key of STATIC_CHUNK_PROFILE_KEYS) {
      if (chunk.meta[key] !== droppable[key]) {
        throw new TypeError(
          `Publishing cannot drop "${chunkId}": its ${key} does not match the `
          + 'canonical chunk of that name, so this step cannot tell what it is.'
        );
      }
    }
    const loss = describeDroppedChunkLoss(
      await decodeJsonChunkPayload(chunk),
      chunkId
    );
    if (loss !== null) {
      throw new Error(
        `Publishing would discard "${chunkId}", which is not empty: ${loss}. `
        + 'A published default has no chunk to carry it, so publishing this '
        + 'capture would lose it silently. Clear it in the application and '
        + 'capture the state again.'
      );
    }
  }

  assertPublishedDefaultChunkProfile(kept.map(chunk => chunk.meta));

  let aggregateUncompressedBytes = 0;
  for (const chunk of kept) {
    aggregateUncompressedBytes += assertSafeInteger(
      chunk.meta.uncompressedBytes,
      `Published default chunk "${chunk.meta.id}" uncompressedBytes`,
      { maximum: MAX_PUBLISHED_DEFAULT_UNCOMPRESSED_BYTES }
    );
  }
  if (aggregateUncompressedBytes > MAX_PUBLISHED_DEFAULT_UNCOMPRESSED_BYTES) {
    throw new RangeError(
      'Published default session exceeds the 64 KiB aggregate uncompressed byte limit.'
    );
  }

  const trimmed = writeBundle({
    manifest: {
      createdAt: manifest.createdAt,
      datasetFingerprint: rebindPublishedDefaultFingerprint(
        manifest.datasetFingerprint,
        publishedIdentity
      ),
      chunks: kept.map(chunk => chunk.meta)
    },
    chunks: kept.map(chunk => chunk.bytes)
  });
  if (trimmed.size > MAX_PUBLISHED_DEFAULT_STATE_BYTES) {
    throw new RangeError(
      'Published default session exceeds the 32 KiB byte limit.'
    );
  }
  return trimmed;
}
