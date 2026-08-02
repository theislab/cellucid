/**
 * Save State and a published `default.cellucid-session` are different
 * documents, and nothing said so (CEL-0248).
 *
 * Save State writes every chunk the registered contributors emit — seven for a
 * session with nothing kept. `restorePublishedDefaultState()` accepts exactly
 * five, in one order, and refuses a cinematic chunk by name before anything
 * else. So publishing a preset means dropping `cinematic/camera` and
 * `analysis/cache-inventory`, and that drop is lossless only while both are
 * empty: a recorded camera path dropped from a save is gone, the file that
 * ships still loads, and nothing downstream ever notices.
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
 * seven-chunk save is built out of `CURRENT_GENERIC_STATIC_CHUNK_PROFILES`, the
 * five expected survivors out of `PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE`, and
 * the two casualties out of `PUBLISHED_DEFAULT_DROPPED_CHUNK_PROFILES`, which is
 * itself the difference between the two. An eighth chunk added to the session
 * joins this file's fixtures the day it lands.
 */

import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
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
  trimToPublishedDefault,
} from '../assets/js/app/session/published-default.js';
import {
  SessionSerializer,
} from '../assets/js/app/session/session-serializer.js';

const PRESET_REPOSITORY_URL = new URL('../../cellucid-datasets/', import.meta.url);
const PRESET_EXPORTS_URL = new URL('exports/', PRESET_REPOSITORY_URL);
const PRESET_FILENAME = 'default.cellucid-session';

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
  'analysis/cache-inventory': Object.freeze({ artifactIds: [] }),
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
 * @param {{ profile: object, payload: any }[]} emissions
 */
function makeSerializer(emissions) {
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

  return new SessionSerializer({
    state: {
      getDatasetGeneration: () => 0,
      obsData: { fields: [] },
      pointCount: 3,
      getViewDimensionLevel: () => 3,
      positionsArray: new Float32Array(9),
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
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
      : EMPTY_DROPPED_PAYLOADS[profile.id] ?? { chunkId: profile.id },
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

/* ------------------------------------------------------------------ *
 * 1. A seven-chunk save fails the check.
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

test('a save trimmed of only the cinematic chunk still fails the count', async () => {
  // Dropping the chunk the reader names, and stopping there, is the plausible
  // wrong trim: the loud refusal goes away and a six-chunk file remains.
  const save = await captureSave();
  const { manifest } = await readBundleParts(save);
  const withoutCinematic = manifest.chunks.filter(
    chunk => chunk.contributorId !== 'cinematic-camera',
  );

  assert.equal(
    withoutCinematic.length,
    PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.length + 1,
    'exactly one chunk must be cinematic, or this case is testing something '
      + 'other than the half-done trim',
  );
  assert.throws(
    () => assertPublishedDefaultChunkProfile(withoutCinematic),
    /must match the exact static profile/,
    'the check must still refuse a save that dropped only the chunk it was '
      + 'told about by name',
  );
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

  const refusal = await refusalOf(() => trimToPublishedDefault(save));
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
  const cleared = await trimToPublishedDefault(await captureSave());
  assert.deepEqual(
    (await readBundleParts(cleared)).manifest.chunks.map(chunk => chunk.id),
    KEPT_IDS,
  );
});

test('the trim refuses to discard a non-empty analysis cache inventory', async () => {
  const save = await captureSave({
    'analysis/cache-inventory': {
      artifactIds: ['analysis/artifacts/bulk-gene/page_1/CD8A'],
    },
  });

  const refusal = await refusalOf(() => trimToPublishedDefault(save));
  assert.ok(refusal !== null, 'the trim must refuse a save with cached artifacts');
  assert.match(refusal, /analysis\/cache-inventory/);
  assert.match(refusal, /artifactIds holds 1 entry/);
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

  const refusal = await refusalOf(() => trimToPublishedDefault(save));
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
    'analysis/cache-inventory': { artifactIds: [], pending: { gene: 'CD8A' } },
  });

  const refusal = await refusalOf(() => trimToPublishedDefault(save));
  assert.ok(refusal !== null, 'the trim must refuse an unrecognised payload shape');
  assert.match(refusal, /pending is a nested record this publish step cannot prove empty/);
});

/* ------------------------------------------------------------------ *
 * 3. A correct five-chunk preset passes.
 * ------------------------------------------------------------------ */

test('the trim turns an empty save into a preset the application accepts', async () => {
  const save = await captureSave();
  const saveParts = await readBundleParts(save);
  const trimmed = await trimToPublishedDefault(save);
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

  // Nothing was rewritten on the way through: the surviving chunks are the
  // bytes the application itself wrote, and the manifest keeps the capture's
  // own provenance.
  assert.equal(trimmedParts.manifest.createdAt, saveParts.manifest.createdAt);
  assert.deepEqual(
    trimmedParts.manifest.datasetFingerprint,
    saveParts.manifest.datasetFingerprint,
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

  // The real acceptance: the application restores it, and restores every chunk.
  const restored = [];
  const reader = makeSerializer(
    PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.map(profile => ({
      profile,
      payload: { chunkId: profile.id },
    })),
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
 * The committed presets, or `null` when the sibling repository is not checked
 * out. Only an absent *repository* is a reason to skip; a repository that is
 * present but publishes nothing is a defect, and is left to fail.
 */
async function readPublishedPresets() {
  try {
    if (!(await stat(PRESET_REPOSITORY_URL)).isDirectory()) return null;
  } catch {
    return null;
  }

  const entries = await readdir(PRESET_EXPORTS_URL, { withFileTypes: true });
  const presets = [];
  for (const entry of entries.filter(candidate => candidate.isDirectory())) {
    const presetUrl = new URL(
      `${entry.name}/${PRESET_FILENAME}`,
      PRESET_EXPORTS_URL,
    );
    let bytes;
    try {
      bytes = await readFile(presetUrl);
    } catch {
      continue;
    }
    presets.push({
      label: `${entry.name}/${PRESET_FILENAME}`,
      blob: new Blob([bytes]),
    });
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
    `${PRESET_EXPORTS_URL.pathname} exists but publishes no ${PRESET_FILENAME}; `
      + 'an empty exports tree must not read as agreement',
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
