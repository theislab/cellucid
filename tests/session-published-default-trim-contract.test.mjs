/**
 * Save State and a published sample preset (`anndata/<id>.cellucid-session`) are different
 * documents, and nothing said so (CEL-0248).
 *
 * Save State writes every chunk the registered contributors emit — eight for a
 * session with nothing kept. `restorePublishedDefaultState()` accepts exactly
 * seven, in one order, and refuses a cinematic chunk by name before anything
 * else. So publishing a preset means dropping `cinematic/camera`, and that
 * drop is lossless only while it is empty: a recorded camera path dropped from
 * a save is gone, the file that ships still loads, and nothing downstream ever
 * notices.
 *
 * That was done by hand, correctly, once. This file makes both halves
 * executable:
 *
 *  - the **check** — `assertPublishedDefaultChunkProfile()` run against every
 *    committed preset. It is the same function `restorePublishedDefaultState()`
 *    runs, so this asks the application whether it would accept the file rather
 *    than comparing it against a copy of the application's list.
 *  - the **trim** — `trimToPublishedDefault()`, which drops what the profile has
 *    no room for and refuses when a dropped chunk carries anything.
 *
 * Nothing below restates which chunks are accepted or which are dropped. The
 * full save is built out of `CURRENT_GENERIC_STATIC_CHUNK_PROFILES`, the
 * expected survivors out of `PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE`, and the
 * casualties out of `PUBLISHED_DEFAULT_DROPPED_CHUNK_PROFILES`, which is itself
 * the difference between the two. A singleton chunk added to the session joins
 * this file's fixtures the day it lands.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import {
  readBundle,
} from '../assets/js/app/session/bundle/reader.js';
import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import {
  CURRENT_GENERIC_STATIC_CHUNK_PROFILES,
  PUBLISHED_DEFAULT_DROPPED_CHUNK_PROFILES,
  PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE,
  STATIC_CHUNK_PROFILE_KEYS,
  assertPublishedDefaultChunkProfile,
  rebindPublishedDefaultFingerprint,
  trimToPublishedDefault,
} from '../assets/js/app/session/published-default.js';
import {
  SessionSerializer,
} from '../assets/js/app/session/session-serializer.js';
import {
  createInMemoryAnnDataDimensionManager,
  describeOwnVarCount,
  inMemoryAnnDataMapping,
} from './helpers/in-memory-anndata.mjs';

const PRESET_REPOSITORY_URL = new URL('../../cellucid-datasets/', import.meta.url);
const PRESET_CATALOG_URL = new URL('anndata/datasets.json', PRESET_REPOSITORY_URL);

const KEPT_IDS = PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.map(
  profile => profile.id,
);
const DROPPED_IDS = PUBLISHED_DEFAULT_DROPPED_CHUNK_PROFILES.map(
  profile => profile.id,
);

/* ------------------------------------------------------------------ *
 * A save built by the real serializer.
 *
 * The contributors are synthesized from the profile constants rather than
 * imported from `contributors/`, because the real ones read live viewer,
 * highlight and analysis state. What matters here is the *manifest* a save
 * produces, and that is decided by the profiles, which are the real ones.
 * ------------------------------------------------------------------ */

/**
 * A payload each droppable chunk carries when nothing was recorded in it.
 *
 * Keyed and ordered by `PUBLISHED_DEFAULT_DROPPED_CHUNK_PROFILES`, which the
 * first test asserts, so this object cannot fall behind the derived set.
 */
const EMPTY_DROPPED_PAYLOADS = Object.freeze({
  'cinematic/camera': Object.freeze({
    keyframes: [],
    nextIndex: 1,
    defaultSpeed: '50',
    autoplay: false,
    invertLook: false,
    orbitReverse: false,
    planarInvertAxes: false,
    planarZoomToCursor: true,
    showOrbitAnchor: true,
    orbitKeySpeed: '20',
    planarPanSpeed: '20',
    lookSensitivity: '10',
    moveSpeed: '20',
  }),
});

/**
 * `restorePublishedDefaultState()` publishes progress through the shared
 * notification centre, which needs a document. Only the restore path is
 * exercised here, so the centre is stubbed for the duration.
 */
async function withNotificationHarness(run) {
  const notifications = getNotificationCenter();
  const names = [
    'completeDownload',
    'dismissDownload',
    'failDownload',
    'info',
    'startDownload',
    'updateDownload',
  ];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  notifications.completeDownload = () => {};
  notifications.dismissDownload = () => {};
  notifications.failDownload = () => {};
  notifications.info = () => {};
  notifications.startDownload = () => 'published-default-trim-test';
  notifications.updateDownload = () => {};
  try {
    return await run();
  } finally {
    for (const [name, original] of originals) notifications[name] = original;
  }
}

test('every chunk a save can drop has a fixture that says what empty means', () => {
  // Derived, so this file cannot silently stop covering a chunk. An eighth
  // singleton chunk added to the session lands here as a failure naming itself.
  assert.deepEqual(
    DROPPED_IDS,
    Object.keys(EMPTY_DROPPED_PAYLOADS),
    'the droppable chunks are derived from the session profiles; a new one '
      + 'needs an empty payload here before this file can prove anything about '
      + 'it',
  );
  assert.deepEqual(
    [...KEPT_IDS, ...DROPPED_IDS].sort(),
    CURRENT_GENERIC_STATIC_CHUNK_PROFILES.map(profile => profile.id).sort(),
    'the kept and dropped sets must partition the chunks a save emits, or the '
      + 'trim is deciding about a chunk neither set describes',
  );
  assert.equal(
    new Set([...KEPT_IDS, ...DROPPED_IDS]).size,
    KEPT_IDS.length + DROPPED_IDS.length,
    'no chunk may be both kept and dropped',
  );
  assert.ok(
    DROPPED_IDS.length > 0,
    'a save must drop something on the way to being published, or this whole '
      + 'file is vacuous',
  );
});

/**
 * A serializer whose contributors emit exactly the given chunks.
 *
 * `identity` is what the data-source manager would report. A capture may be
 * taken under another id than the one it is published under, so the two can
 * differ — a serializer that could not express that could not restore a
 * published preset at all.
 *
 * @param {{ profile: object, payload: any }[]} emissions
 * @param {{ datasetId: string }|null} [identity]
 */
/**
 * The data mapping of the serializer's dataset, whose one embedding is
 * an in-memory 3D layout (keyed "3d").
 */
const IN_MEMORY_3D_MAPPING = Object.freeze(inMemoryAnnDataMapping());

function makeSerializer(emissions, identity = null) {
  const byContributor = new Map();
  for (const emission of emissions) {
    const list = byContributor.get(emission.profile.contributorId) ?? [];
    list.push(emission);
    byContributor.set(emission.profile.contributorId, list);
  }
  const contributors = [...byContributor].map(([contributorId, list]) => ({
    id: contributorId,
    capture: () => list.map(({ profile, payload }) => ({
      ...profile,
      payload: structuredClone(payload),
    })),
    restore: () => {},
  }));

  const positionsArray = new Float32Array(9);
  const dimensionManager = createInMemoryAnnDataDimensionManager({
    positions: positionsArray,
    dimension: 3,
  });
  return new SessionSerializer({
    state: {
      getDatasetGeneration: () => 0,
      obsData: { fields: [] },
      pointCount: 3,
      getViewDimensionLevel: () => 3,
      positionsArray,
      dimensionManager,
      getDataMapping: () => IN_MEMORY_3D_MAPPING,
      describeMappingVarCount: describeOwnVarCount,
      getViewLayoutKey: viewId => dimensionManager.getViewLayout(viewId),
      getActiveViewId: () => 'live',
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: identity === null ? null : {
      getCurrentIdentityId: () => identity.datasetId,
      getCurrentSourceType: () => 'local-demo',
      getCurrentDatasetId: () => identity.datasetId,
    },
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    figureExport: null,
    contributors,
  });
}

/**
 * A Save State bundle carrying every chunk a current session emits.
 *
 * @param {Record<string, any>} [overrides] Payloads by chunk id.
 * @param {{ profile: object, payload: any }[]} [extras] Chunks beyond the seven.
 */
function captureSave(overrides = {}, extras = []) {
  const emissions = CURRENT_GENERIC_STATIC_CHUNK_PROFILES.map(profile => ({
    profile,
    payload: Object.hasOwn(overrides, profile.id)
      ? overrides[profile.id]
      : EMPTY_DROPPED_PAYLOADS[profile.id] ?? (
        profile.kind === 'binary'
          ? new TextEncoder().encode(profile.id)
          : { chunkId: profile.id }
      ),
  }));
  return makeSerializer([...emissions, ...extras]).createSessionBundle();
}

/** The manifest and stored bytes of a bundle, through the real reader. */
async function readBundleParts(blob) {
  const { manifest, chunkStream } = await readBundle(blob, {
    signal: null,
    onProgress: null,
  });
  const chunks = [];
  for await (const chunk of chunkStream) chunks.push(chunk);
  return { manifest, chunks };
}

function refusalOf(run) {
  return run().then(
    () => null,
    error => error.message,
  );
}

const PUBLISHED_DATASET_ID = 'trim-contract-generation';

/**
 * The identity this capture would be published under.
 *
 * Publishing renames a capture and may not redescribe it, so the describing
 * fields are read back out of the capture itself: a fixture that stated them
 * independently would be asserting its own arithmetic rather than the rule.
 *
 * @param {Blob} save
 * @param {object} [overrides] Fields to change, for the refusal cases.
 */
async function publishedIdentityFor(save, overrides = {}) {
  const { manifest } = await readBundleParts(save);
  return {
    ...manifest.datasetFingerprint,
    datasetId: PUBLISHED_DATASET_ID,
    ...overrides,
  };
}

/** Trim a capture under the identity it would really be published with. */
async function publish(save, overrides = {}) {
  return trimToPublishedDefault(
    save,
    await publishedIdentityFor(save, overrides),
  );
}

/* ------------------------------------------------------------------ *
 * 1. A full save fails the check.
 * ------------------------------------------------------------------ */

test('a save carries more chunks than a published default accepts', async () => {
  const save = await captureSave();
  const { manifest } = await readBundleParts(save);

  assert.deepEqual(
    manifest.chunks.map(chunk => chunk.id),
    CURRENT_GENERIC_STATIC_CHUNK_PROFILES.map(profile => profile.id),
    'a save must emit every current chunk, or the trim below is trimming '
      + 'something narrower than what Save State actually writes',
  );
  assert.ok(
    manifest.chunks.length > PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.length,
    'a save must carry more than a published default accepts; if these ever '
      + 'become equal there is nothing to trim and this file should go',
  );

  assert.throws(
    () => assertPublishedDefaultChunkProfile(manifest.chunks),
    /must not contain cinematic camera data/,
    'the check must refuse an untrimmed save, and name the chunk whose loss '
      + 'is unrecoverable rather than reporting a wrong shape',
  );

  // The same refusal through the path a user takes: the reader itself.
  await withNotificationHarness(async () => {
    assert.match(
      await refusalOf(() => makeSerializer([]).restorePublishedDefaultState(
        save,
        { refreshUi() {}, signal: new AbortController().signal },
      )) ?? '',
      /must not contain cinematic camera data/,
      'an untrimmed save must be refused by the application, which is what '
        + 'makes publishing one a defect rather than a preference',
    );
  });
});

test('a save without its cinematic chunk is exactly the published profile', async () => {
  // The camera path is the only chunk a published default has no room for, so
  // dropping it (and only it) leaves exactly what the reader accepts.
  const save = await captureSave();
  const { manifest } = await readBundleParts(save);
  const withoutCinematic = manifest.chunks.filter(
    chunk => chunk.contributorId !== 'cinematic-camera',
  );
  assert.equal(manifest.chunks.length, withoutCinematic.length + 1);
  assert.deepEqual(withoutCinematic.map(chunk => chunk.id), KEPT_IDS);
  assert.doesNotThrow(() => assertPublishedDefaultChunkProfile(withoutCinematic));
});

/* ------------------------------------------------------------------ *
 * 2. A non-empty dropped chunk fails the trim, loudly.
 * ------------------------------------------------------------------ */

test('the trim refuses to discard a recorded camera path', async () => {
  const keyframe = {
    id: 'kf_1',
    label: 'Opening',
    durationMs: 1_000,
    camera: { radius: 2.43, theta: 0.78, phi: 0.78, target: [0, 0, 0] },
  };
  const save = await captureSave({
    'cinematic/camera': {
      ...EMPTY_DROPPED_PAYLOADS['cinematic/camera'],
      keyframes: [keyframe],
      nextIndex: 2,
    },
  });

  const refusal = await refusalOf(() => publish(save));
  assert.ok(refusal !== null, 'the trim must refuse a save with a camera path');
  assert.match(
    refusal,
    /cinematic\/camera/,
    'the refusal must name the chunk that would have been lost',
  );
  assert.match(
    refusal,
    /keyframes holds 1 entry/,
    'the refusal must say what was in it, so the author can tell whether the '
      + 'path was the one they meant to record',
  );

  // The same save with the path cleared publishes. Only the keyframe differs
  // between the two, which is what proves the refusal is the recorded path and
  // not something else about this capture.
  const cleared = await publish(await captureSave());
  assert.deepEqual(
    (await readBundleParts(cleared)).manifest.chunks.map(chunk => chunk.id),
    KEPT_IDS,
  );
});

test('the trim refuses a chunk that is not one of the droppable singletons', async () => {
  // Highlight membership, user-defined codes and cached artifacts are user
  // content by construction: the published profile has no chunk to carry them,
  // and there is nothing about them that can be "empty enough" to drop.
  const save = await captureSave({}, [{
    profile: {
      id: 'highlights/cells/group_1',
      contributorId: 'highlights-cells',
      priority: 'lazy',
      kind: 'binary',
      codec: 'gzip',
      label: 'Highlight cells: group_1',
      datasetDependent: true,
    },
    payload: Uint8Array.of(1, 2, 3),
  }]);

  const refusal = await refusalOf(() => publish(save));
  assert.ok(refusal !== null, 'the trim must refuse an unrecognised chunk');
  assert.match(refusal, /highlights\/cells\/group_1/);
  assert.match(
    refusal,
    /not one of the chunks a published default leaves behind/,
    'the refusal must say the chunk is unrecognised rather than empty, '
      + 'because a binary payload is not something this step can judge',
  );
});

test('the trim refuses a dropped chunk whose payload shape is unrecognised', async () => {
  // An array or a nested record inside a droppable payload is content the
  // shape-based emptiness rule has never seen. It refuses rather than walking
  // past it.
  const save = await captureSave({
    'cinematic/camera': {
      ...EMPTY_DROPPED_PAYLOADS['cinematic/camera'],
      pending: { gene: 'CD8A' },
    },
  });

  const refusal = await refusalOf(() => publish(save));
  assert.ok(refusal !== null, 'the trim must refuse an unrecognised payload shape');
  assert.match(refusal, /pending is a nested record this publish step cannot prove empty/);
});

/* ------------------------------------------------------------------ *
 * 2b. Publishing renames the capture, and may only rename it.
 *
 * A preset is authored by serving the prepared generation locally, so the
 * capture records that serve's identity while the catalog serves the same bytes
 * as `local-demo` under the generation's own id. `datasetFingerprintMatches()`
 * compares both fields, so a preset that shipped with the capture's identity
 * was refused on every open and the sample showed none of its published view.
 * Five presets shipped that way.
 * ------------------------------------------------------------------ */

/**
 * The data mapping of an AnnData file that enables PCA beside UMAP and
 * defaults to UMAP in 2D and 3D.
 */
function suoDataMapping() {
  return {
    kind: 'anndata',
    embeddings: {
      enabled: [
        { key: 'X_pca', columns: [0, 1] },
        { key: 'X_umap_2d', columns: [0, 1] },
        { key: 'X_umap_3d', columns: [0, 1, 2] },
      ],
      defaults: {
        '1d': null,
        '2d': { key: 'X_umap_2d', columns: [0, 1] },
        '3d': { key: 'X_umap_3d', columns: [0, 1, 2] },
      },
    },
    knn: 'connectivities',
    geneNames: 'index',
    expression: 'X',
    latent: null,
    vectorFields: [],
  };
}

/** A capture of the Suo generation, under another id, on its 3D UMAP. */
function suoCapture() {
  return {
    datasetId: 'suo-capture',
    name: 'Suo (local capture)',
    cellCount: 561_947,
    varCount: 5_103,
    cellOrder: {
      embedding: { key: 'X_umap_3d', columns: [0, 1, 2] },
      dimension: 3,
      digest: 'a229f7d3347dbb46',
    },
    dataMapping: suoDataMapping(),
  };
}

test('publishing rebinds a local capture to the identity it ships under', async () => {
  const captured = suoCapture();
  const rebound = rebindPublishedDefaultFingerprint(captured, {
    ...structuredClone(captured),
    datasetId: 'suo',
    name: 'Suo et al. 2022',
  });

  // The id and the name are the generation's; everything the capture was
  // taken against is the capture's.
  assert.deepEqual(rebound, {
    datasetId: 'suo',
    name: 'Suo et al. 2022',
    cellCount: 561_947,
    varCount: 5_103,
    cellOrder: {
      embedding: { key: 'X_umap_3d', columns: [0, 1, 2] },
      dimension: 3,
      digest: 'a229f7d3347dbb46',
    },
    dataMapping: suoDataMapping(),
  });
  // The embedding and the mapping are carried as copies, never shared with
  // the capture they were read from.
  assert.notStrictEqual(rebound.cellOrder.embedding, captured.cellOrder.embedding);
  assert.notStrictEqual(rebound.dataMapping, captured.dataMapping);
  assert.notEqual(
    rebound.datasetId,
    captured.datasetId,
    'the rename is the whole point; a rebinding that kept the capture id would '
      + 'reproduce the defect this function exists to make impossible',
  );
});

test('publishing refuses to restate what a capture was taken against', async () => {
  const captured = suoCapture();
  const published = {
    ...suoCapture(),
    datasetId: 'suo',
  };
  const cellOrder = changes => ({ cellOrder: { ...captured.cellOrder, ...changes } });

  // Each describing field, one at a time, so a rule that checked only some of
  // them fails here naming the one it skipped.
  const corruptions = [
    ['cell count', { cellCount: 561_946 }],
    ['gene count', { varCount: 5_102 }],
    ['cell-order embedding', cellOrder({ embedding: { key: 'X_pca', columns: [0, 1, 2] } })],
    ['cell-order digest', cellOrder({ digest: '0000000000000000' })],
    ['data mapping', { dataMapping: { ...suoDataMapping(), geneNames: 'column:gene_symbols' } }],
    [
      'data mapping',
      {
        dataMapping: {
          ...suoDataMapping(),
          vectorFields: [{ key: 'velocity_umap_3d', embedding: { key: 'X_umap_3d', columns: [0, 1, 2] } }],
        },
      },
    ],
  ];
  for (const [label, override] of corruptions) {
    assert.throws(
      () => rebindPublishedDefaultFingerprint(captured, {
        ...published,
        ...override,
      }),
      new RegExp(`cannot be published as "suo".*${label}`, 's'),
      `a capture whose ${label} disagrees with the generation must be refused, `
        + 'because publishing it would stamp the generation\'s name onto data '
        + 'that is not the generation\'s',
    );
  }
});

test('publishing refuses a capture whose fingerprint is not a format-2 record', async () => {
  // A record without its data mapping and cell-order embedding cannot be
  // verified, so it cannot be rebound whatever identity it is given.
  const { dataMapping: _dataMapping, ...withoutMapping } = suoCapture();
  const incomplete = {
    ...withoutMapping,
    cellOrder: { dimension: 3, digest: 'a229f7d3347dbb46' },
  };
  assert.throws(
    () => rebindPublishedDefaultFingerprint(incomplete, {
      ...suoCapture(),
      datasetId: 'suo',
    }),
    /exact keys/,
  );
});

test('publishing refuses a published identity that names no generation', async () => {
  const captured = {
    ...suoCapture(),
    cellCount: 3,
    varCount: 0,
    cellOrder: {
      embedding: { key: 'X_umap_3d', columns: [0, 1, 2] },
      dimension: 3,
      digest: '0123456789abcdef',
    },
  };
  // `null` is the identity a viewer with no data-source manager reports, and
  // the fingerprint schema permits it, so this is the one the rebinding itself
  // has to refuse rather than the schema.
  assert.throws(
    () => rebindPublishedDefaultFingerprint(captured, {
      ...captured,
      datasetId: null,
    }),
    /must name the generation it ships beside/,
  );
  assert.throws(
    () => rebindPublishedDefaultFingerprint(captured, {
      ...captured,
      datasetId: '',
    }),
    /datasetId must be a nonempty trimmed string/,
    'an empty id is refused by the fingerprint schema before the rebinding '
      + 'rule sees it, which is the same answer by a shorter route',
  );
});

test('the trim will not publish a capture without an identity to publish it under', async () => {
  const save = await captureSave();
  const refusal = await refusalOf(() => trimToPublishedDefault(save));
  assert.ok(
    refusal !== null,
    'omitting the identity must be refused rather than producing a file that '
      + 'carries the capture identity by default -- that default is exactly '
      + 'what once shipped five inert presets',
  );
  assert.match(refusal, /Published dataset fingerprint/);
});

/* ------------------------------------------------------------------ *
 * 3. A correct preset passes.
 * ------------------------------------------------------------------ */

test('the trim turns an empty save into a preset the application accepts', async () => {
  const save = await captureSave();
  const saveParts = await readBundleParts(save);
  const trimmed = await publish(save);
  const trimmedParts = await readBundleParts(trimmed);

  assert.deepEqual(
    trimmedParts.manifest.chunks.map(chunk => chunk.id),
    KEPT_IDS,
    'the trimmed file must carry exactly the accepted chunks in the accepted '
      + 'order',
  );
  assert.doesNotThrow(
    () => assertPublishedDefaultChunkProfile(trimmedParts.manifest.chunks),
  );

  // Nothing was rewritten on the way through except the identity: the
  // surviving chunks are the bytes the application itself wrote, and the
  // manifest keeps the capture's own provenance.
  assert.equal(trimmedParts.manifest.createdAt, saveParts.manifest.createdAt);
  assert.deepEqual(
    trimmedParts.manifest.datasetFingerprint,
    {
      ...saveParts.manifest.datasetFingerprint,
      datasetId: PUBLISHED_DATASET_ID,
    },
    'publishing renames the capture and changes nothing else about what it '
      + 'was taken against',
  );
  for (const kept of trimmedParts.chunks) {
    const original = saveParts.chunks.find(
      chunk => chunk.meta.id === kept.meta.id,
    );
    assert.deepEqual(kept.meta, original.meta, `${kept.meta.id} metadata`);
    assert.deepEqual(
      Buffer.from(kept.bytes),
      Buffer.from(original.bytes),
      `${kept.meta.id} stored bytes must be the ones the save wrote`,
    );
  }

  // The real acceptance: the application restores it, and restores every
  // chunk. The reader is the catalog opening the sample, so it presents the
  // published identity — which is what the rebinding above exists to match, and
  // what a preset carrying its capture's identity fails against.
  const restored = [];
  const reader = makeSerializer(
    PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.map(profile => ({
      profile,
      payload: profile.kind === 'binary'
        ? new TextEncoder().encode(profile.id)
        : { chunkId: profile.id },
    })),
    { datasetId: PUBLISHED_DATASET_ID },
  );
  for (const contributor of reader._contributors) {
    contributor.restore = (_ctx, meta) => restored.push(meta.id);
  }
  await withNotificationHarness(() => reader.restorePublishedDefaultState(
    trimmed,
    { refreshUi() {}, signal: new AbortController().signal },
  ));
  assert.deepEqual(restored, KEPT_IDS);
});

/* ------------------------------------------------------------------ *
 * 4. The check, run against the files that ship.
 * ------------------------------------------------------------------ */

/**
 * The presets the sample catalog advertises, or `null` when the sibling
 * repository is not checked out. Each is read at its `anndata/datasets.json`
 * session path and held to the byte length and SHA-256 the catalog declares,
 * as the viewer holds it. Only an absent *repository* is a reason to skip; a
 * present repository whose catalog advertises nothing is a defect and fails.
 */
async function readPublishedPresets() {
  try {
    if (!(await stat(PRESET_REPOSITORY_URL)).isDirectory()) return null;
  } catch {
    return null;
  }

  const catalog = JSON.parse(await readFile(PRESET_CATALOG_URL, 'utf8'));
  assert.equal(catalog.schema, 2, 'the sample catalog must be schema 2');
  const presets = [];
  for (const entry of catalog.datasets) {
    if (entry.session === undefined) continue;
    const label = `anndata/${entry.session.path}`;
    const bytes = await readFile(new URL(entry.session.path, PRESET_CATALOG_URL));
    assert.equal(bytes.byteLength, entry.session.bytes, `${label} must be the byte length the catalog declares`);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      entry.session.sha256,
      `${label} must have the SHA-256 the catalog declares`,
    );
    presets.push({ label, blob: new Blob([bytes]) });
  }
  return presets.sort((left, right) => left.label.localeCompare(right.label));
}

test('every published preset carries exactly the accepted chunks', async (t) => {
  const presets = await readPublishedPresets();
  if (presets === null) {
    t.skip(
      'the cellucid-datasets repository is not checked out beside this one, '
        + 'so the published presets cannot be read here',
    );
    return;
  }
  assert.ok(
    presets.length > 0,
    `${PRESET_CATALOG_URL.pathname} advertises no session; a catalog without `
      + 'presets must not read as agreement',
  );

  for (const preset of presets) {
    const { manifest } = await readBundleParts(preset.blob);
    const refusal = (() => {
      try {
        assertPublishedDefaultChunkProfile(manifest.chunks);
        return null;
      } catch (error) {
        return error.message;
      }
    })();
    assert.equal(
      refusal,
      null,
      `${preset.label} is not a published default the application would `
        + `accept: ${refusal}\n`
        + `  chunks on disk: ${manifest.chunks.map(chunk => chunk.id).join(', ')}\n`
        + `  chunks accepted: ${KEPT_IDS.join(', ')}\n`
        + '  a save has to be trimmed before it is published; '
        + 'trimToPublishedDefault() in assets/js/app/session/published-default.js '
        + 'performs that trim and refuses when it would lose anything.',
    );

    // Beyond the ids: every profile field is compared, so a preset that moved a
    // payload to another contributor or relabelled one is caught here too.
    for (const [index, chunk] of manifest.chunks.entries()) {
      const expected = PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE[index];
      for (const key of STATIC_CHUNK_PROFILE_KEYS) {
        assert.equal(
          chunk[key],
          expected[key],
          `${preset.label} chunk ${index} ${key}`,
        );
      }
    }
  }
});

test('a published preset with a chunk appended stops being accepted', async (t) => {
  // The committed presets pass, so the test above proves nothing on its own
  // until an artifact that must fail does. This takes a real preset and gives
  // it back the chunk publishing removed.
  const presets = await readPublishedPresets();
  if (presets === null) {
    t.skip('the cellucid-datasets repository is not checked out beside this one');
    return;
  }

  const { manifest } = await readBundleParts(presets[0].blob);
  for (const profile of PUBLISHED_DEFAULT_DROPPED_CHUNK_PROFILES) {
    assert.throws(
      () => assertPublishedDefaultChunkProfile([
        ...manifest.chunks,
        { ...profile, storedBytes: 33, uncompressedBytes: 13 },
      ]),
      /must not contain cinematic camera data|must match the exact static profile/,
      `${presets[0].label} carrying "${profile.id}" again must be refused`,
    );
  }
});
