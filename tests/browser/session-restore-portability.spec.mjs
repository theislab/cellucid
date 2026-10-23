/**
 * A session restores in an engine other than the one that saved it, and a
 * restore announces its outcome once.
 *
 * A camera state carries two representations: the orbit half and the
 * free-fly half. Only the one its navigation mode drives is authoritative; the
 * viewer reports the other by deriving it through `Math.sin`, `Math.atan2` and
 * `Math.asin`, whose last bits ECMAScript leaves to the engine. The published
 * He and Kanemaru sample views were saved in WebKit, which derives their
 * live-camera pitch as `-0.16539816339745403`; Chromium and Firefox derive
 * `-0.16539816339745406`. Multiview restore compared the derived half bit for
 * bit, refused the camera, and then re-asserted the same unreachable camera
 * from its rollback — so both samples opened with "Multiview restoration
 * failed and graph rollback was incomplete." in every engine but WebKit.
 *
 * These specs reproduce that portably: they save a session in the engine under
 * test and move the derived half by one unit in the last place, which is what
 * a different engine's derivation looks like. Before the fix every engine
 * refused the file.
 *
 * The same restores also count their notifications. A successful restore
 * published "Session fully restored." twice — once as its own progress entry
 * and once as a second toast — and Load State then added "Session loaded
 * successfully" on top. A failed published sample view was announced twice as
 * well: by the restore's progress entry and by "Sample view unavailable".
 */
import { PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE } from '../../assets/js/app/session/published-default.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';
import { readBundle } from '../../assets/js/app/session/bundle/reader.js';
import { writeBundle } from '../../assets/js/app/session/bundle/writer.js';
import { NOT_A_SESSION_FILE_MESSAGE } from '../../assets/js/app/session/bundle/format.js';
import {
  gzipCompress,
  gzipDecompress,
} from '../../assets/js/app/session/codecs/gzip.js';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=session-restore-portability-ci';

const CATALOG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'catalog',
  'datasets.json',
);

const PUBLISHED_DEFAULT_CHUNK_IDS = Object.freeze(
  PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.map(profile => profile.id),
);

const RESTORED = 'Session fully restored.';

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
}

/**
 * Pose the live camera the way the He sample view is posed, in the mode the
 * viewer is in, so its derived half goes through the transcendental functions.
 */
async function poseCamera(page) {
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const camera = viewer.getCameraState();
    viewer.setCameraState({
      ...camera,
      orbit: {
        ...camera.orbit,
        radius: 2.353322246692734,
        targetRadius: 2.353322246692734,
        theta: 0.530398163397444,
        phi: 1.4053981633974426,
      },
    });
  });
}

async function saveSession(page, testInfo, name) {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath(name);
  await download.saveAs(sessionPath);
  return readFile(sessionPath);
}

async function readChunks(bytes) {
  const { manifest, chunkStream } = await readBundle(
    new Blob([bytes]),
    { signal: null, onProgress: null },
  );
  const chunks = [];
  for await (const chunk of chunkStream) chunks.push(chunk);
  return { manifest, chunks };
}

/**
 * Rewrite the `core/state` chunk and, optionally, keep only `chunkIds` as a
 * published default does: with no recorded source, since it is applied to the
 * sample it ships beside. The rewritten chunk keeps its canonical codec.
 */
async function rewriteSession(bytes, editCoreState, chunkIds = null) {
  const { manifest, chunks } = await readChunks(bytes);
  const selected = chunkIds === null
    ? chunks
    : chunkIds.map(chunkId => {
      const chunk = chunks.find(candidate => candidate.meta.id === chunkId);
      if (chunk === undefined) throw new Error(`no "${chunkId}" chunk`);
      return chunk;
    });
  const rewritten = [];
  for (const chunk of selected) {
    if (chunk.meta.id !== 'core/state') {
      rewritten.push(chunk);
      continue;
    }
    const raw = chunk.meta.codec === 'gzip'
      ? await gzipDecompress(chunk.bytes, {
        maxOutputBytes: chunk.meta.uncompressedBytes,
        signal: null,
      })
      : chunk.bytes;
    const payload = JSON.parse(new TextDecoder().decode(raw));
    editCoreState(payload);
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    const stored = chunk.meta.codec === 'gzip'
      ? await gzipCompress(encoded, { signal: null })
      : encoded;
    rewritten.push({
      meta: {
        ...chunk.meta,
        storedBytes: stored.byteLength,
        uncompressedBytes: encoded.byteLength,
      },
      bytes: stored,
    });
  }
  const blob = writeBundle({
    manifest: {
      ...manifest,
      source: chunkIds === null ? manifest.source : null,
      chunks: rewritten.map(chunk => chunk.meta),
    },
    chunks: rewritten.map(chunk => chunk.bytes),
  });
  return Buffer.from(await blob.arrayBuffer());
}

/** One unit in the last place, away from zero. */
function nextUp(value) {
  return value === 0 ? Number.MIN_VALUE : value * (1 + Number.EPSILON);
}

/**
 * Move every derived camera half by one ULP: what the same pose looks like
 * when another engine computed the half the navigation mode does not drive.
 */
function deriveInAnotherEngine(camera) {
  if (camera.navigationMode === 'free') {
    for (const key of ['radius', 'targetRadius', 'theta', 'phi']) {
      camera.orbit[key] = nextUp(camera.orbit[key]);
    }
  } else {
    camera.freefly.position = camera.freefly.position.map(nextUp);
    camera.freefly.yaw = nextUp(camera.freefly.yaw);
    camera.freefly.pitch = nextUp(camera.freefly.pitch);
  }
}

function moveDerivedCameraBits(payload) {
  deriveInAnotherEngine(payload.multiview.live.cameraState);
  for (const snapshot of payload.multiview.snapshots) {
    deriveInAnotherEngine(snapshot.cameraState);
  }
}

/**
 * Keep every notification element the page ever publishes.
 *
 * A count of what is on screen is not a count of what was announced: the
 * second "Session fully restored." toast expired after 2.2 s, so a retrying
 * on-screen count went green once it had gone. The recorder holds each element
 * past its removal, and a notification updated in place (a progress entry
 * that completes or fails) is still one element.
 */
async function recordNotifications(page) {
  await page.addInitScript(() => {
    const published = [];
    window.__publishedNotifications = published;
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node.nodeType === Node.ELEMENT_NODE
            && node.classList.contains('notification')
            && !published.includes(node)
          ) {
            published.push(node);
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

async function forgetNotifications(page) {
  await page.evaluate(() => {
    window.__publishedNotifications.length = 0;
  });
}

/** Title and message of every recorded notification, as last published. */
function publishedNotifications(page) {
  return page.evaluate(() => window.__publishedNotifications.map(element => ({
    title: element.querySelector('.notification-title')?.textContent.trim()
      ?? '',
    message: element.querySelector('.notification-message')?.textContent
      .trim() ?? '',
  })));
}

async function expectAnnounced(page, predicate, count, description) {
  await expect.poll(
    async () => (await publishedNotifications(page)).filter(predicate).length,
    { message: description },
  ).toBeGreaterThanOrEqual(count === 0 ? 0 : 1);
  const matches = (await publishedNotifications(page)).filter(predicate);
  expect(matches, description).toHaveLength(count);
}

const restored = ({ message }) => message === RESTORED;
const loadingFailed = ({ title }) => title === 'Loading failed';
const sampleViewUnavailable = ({ title }) => title === 'Sample view unavailable';

async function readLiveOrbit(page) {
  return page.evaluate(() => window._cellucidViewer.getCameraState().orbit);
}

test('a session saved by another engine restores, and says so once', async ({
  page,
}, testInfo) => {
  const productErrors = observeProductErrors(page);
  await recordNotifications(page);
  await openDataset(page);
  await poseCamera(page);
  const savedOrbit = await readLiveOrbit(page);
  // A kept view, so the multiview graph replays and re-applies the live
  // camera after it.
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('#split-view-badges-list > *')).not.toHaveCount(0);

  const sessionBytes = await rewriteSession(
    await saveSession(page, testInfo, 'saved.cellucid-session'),
    moveDerivedCameraBits,
  );

  // Drift the camera so the restore has something to put back.
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const camera = viewer.getCameraState();
    viewer.setCameraState({
      ...camera,
      orbit: { ...camera.orbit, radius: camera.orbit.radius * 1.7 },
    });
  });
  await forgetNotifications(page);

  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'other-engine.cellucid-session',
    mimeType: 'application/octet-stream',
    buffer: sessionBytes,
  });

  await expectAnnounced(
    page,
    restored,
    1,
    'a successful restore is announced exactly once',
  );
  // Load State used to add a third announcement of the same event.
  expect(await publishedNotifications(page)).toEqual([
    { title: 'Loaded', message: RESTORED },
  ]);
  await expect(page.locator('#split-view-badges-list > *')).not.toHaveCount(0);
  expect(await readLiveOrbit(page)).toEqual(savedOrbit);
  expect(productErrors).toEqual([]);
});

test('a session saved on one route restores on the same dataset opened from a link', async ({
  page,
}, testInfo) => {
  // A session belongs to the dataset, not to the way it was opened: the same
  // catalog opened from a web address (another origin, the link source)
  // accepts a session saved on the sample catalog.
  const productErrors = observeProductErrors(page);
  await recordNotifications(page);
  await openDataset(page);
  await poseCamera(page);
  const savedOrbit = await readLiveOrbit(page);
  const sessionBytes = await saveSession(page, testInfo, 'catalog.cellucid-session');

  const link = `${SAMPLE_ORIGIN}/tests/browser/fixtures/catalog/`;
  await page.goto(
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(link)}&dataset=current-ui`,
    { waitUntil: 'domcontentloaded' },
  );
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await forgetNotifications(page);

  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'catalog.cellucid-session',
    mimeType: 'application/octet-stream',
    buffer: sessionBytes,
  });

  await expectAnnounced(page, restored, 1, 'the session restores on the linked copy');
  expect(await readLiveOrbit(page)).toEqual(savedOrbit);
  expect(productErrors).toEqual([]);
});

async function loadSessionFile(page, name, bytes) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name,
    mimeType: 'application/octet-stream',
    buffer: bytes,
  });
}

test('a session reopens the dataset it records, from a sample or a link', async ({
  page,
}, testInfo) => {
  // The manifest records where the dataset was opened from, so loading the
  // session with another dataset (or none) open opens its own one first.
  const productErrors = observeProductErrors(page);
  await recordNotifications(page);
  await openDataset(page);
  await poseCamera(page);
  const sampleOrbit = await readLiveOrbit(page);
  const sampleSession = await saveSession(page, testInfo, 'sample.cellucid-session');
  expect((await readChunks(sampleSession)).manifest.source).toEqual({
    kind: 'sample',
    dataset: 'current-ui',
  });

  await page.locator('#dataset-select').selectOption('__none__');
  await expect(page.locator('#dataset-name')).not.toHaveText(
    'Current UI fixture',
  );
  await forgetNotifications(page);
  await loadSessionFile(page, 'sample.cellucid-session', sampleSession);
  await expectAnnounced(page, restored, 1, 'the sample reopens and restores');
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  expect(await readLiveOrbit(page)).toEqual(sampleOrbit);

  // The same file, linked by its address: it states its id (current-ui).
  const link = `${SAMPLE_ORIGIN}/tests/browser/fixtures/catalog/current-ui.h5ad`;
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(link)}`, {
    waitUntil: 'domcontentloaded',
  });
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await poseCamera(page);
  const linkOrbit = await readLiveOrbit(page);
  const linkSession = await saveSession(page, testInfo, 'link.cellucid-session');
  expect((await readChunks(linkSession)).manifest.source).toEqual({
    kind: 'link',
    locator: link,
    dataset: expect.any(String),
  });

  await openDataset(page);
  await page.locator('#dataset-select').selectOption('__none__');
  await forgetNotifications(page);
  await loadSessionFile(page, 'link.cellucid-session', linkSession);
  await expectAnnounced(page, restored, 1, 'the link reopens and restores');
  await expect(page.locator('#data-link-url')).toHaveValue(link);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  expect(await readLiveOrbit(page)).toEqual(linkOrbit);
  expect(productErrors).toEqual([]);
});

async function servePublishedDefault(page, stateBytes) {
  const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));
  catalog.datasets[0].session = {
    path: 'current-ui.cellucid-session',
    bytes: stateBytes.byteLength,
    sha256: createHash('sha256').update(stateBytes).digest('hex'),
  };
  await page.route('**/tests/browser/fixtures/catalog/datasets.json', route =>
    route.fulfill({
      body: JSON.stringify(catalog),
      contentType: 'application/json',
      status: 200,
    }));
  await page.route(
    '**/tests/browser/fixtures/catalog/current-ui.cellucid-session',
    route => route.fulfill({
      body: stateBytes,
      contentType: 'application/octet-stream',
      status: 200,
    }),
  );
}

test('a published sample view saved by another engine applies, and says so once', async ({
  page,
}, testInfo) => {
  const productErrors = observeProductErrors(page);
  await recordNotifications(page);
  await openDataset(page);
  await poseCamera(page);
  const savedOrbit = await readLiveOrbit(page);
  const stateBytes = await rewriteSession(
    await saveSession(page, testInfo, 'published.cellucid-session'),
    moveDerivedCameraBits,
    PUBLISHED_DEFAULT_CHUNK_IDS,
  );
  await servePublishedDefault(page, stateBytes);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('html')).toHaveAttribute(
    'data-startup-phase',
    'ready',
  );
  await expectAnnounced(
    page,
    restored,
    1,
    'the applied sample view is announced exactly once',
  );
  const published = await publishedNotifications(page);
  expect(published.filter(sampleViewUnavailable)).toEqual([]);
  expect(published.filter(loadingFailed)).toEqual([]);
  expect(await readLiveOrbit(page)).toEqual(savedOrbit);
  expect(productErrors).toEqual([]);
});

test('a published sample view that cannot be applied is reported once', async ({
  page,
}, testInfo) => {
  await recordNotifications(page);
  await openDataset(page);
  let rewroteSelect = false;
  const stateBytes = await rewriteSession(
    await saveSession(page, testInfo, 'broken.cellucid-session'),
    payload => {
      // A select value the control does not offer: refused by the restore
      // after the bundle has been read, inside the restore transaction.
      for (const control of Object.values(payload.uiControls)) {
        if (control.type === 'select') {
          control.value = 'not-an-offered-option';
          rewroteSelect = true;
          return;
        }
      }
    },
    PUBLISHED_DEFAULT_CHUNK_IDS,
  );
  expect(rewroteSelect, 'the saved session must contain a select').toBe(true);
  await servePublishedDefault(page, stateBytes);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expectAnnounced(
    page,
    sampleViewUnavailable,
    1,
    'the failed sample view is announced exactly once',
  );
  const published = await publishedNotifications(page);
  expect(
    published.filter(loadingFailed),
    'the restore progress entry must not repeat the sample-view failure',
  ).toEqual([]);
  expect(published.filter(restored)).toEqual([]);
});

test('a published sample view applies when its catalog is opened from a link', async ({
  page,
}, testInfo) => {
  // datasets.json is one format however it is opened: the same catalog
  // linked with ?data= applies the default session it names.
  const productErrors = observeProductErrors(page);
  await recordNotifications(page);
  await openDataset(page);
  await poseCamera(page);
  const savedOrbit = await readLiveOrbit(page);
  const stateBytes = await rewriteSession(
    await saveSession(page, testInfo, 'published.cellucid-session'),
    () => {},
    PUBLISHED_DEFAULT_CHUNK_IDS,
  );
  await servePublishedDefault(page, stateBytes);

  const link = `${SAMPLE_ORIGIN}/tests/browser/fixtures/catalog/`;
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(link)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expectAnnounced(page, restored, 1, 'the linked catalog applies its starting view');
  expect(await readLiveOrbit(page)).toEqual(savedOrbit);
  expect(productErrors).toEqual([]);
});

test('a file without the format-2 signature is refused, and nothing changes', async ({
  page,
}, testInfo) => {
  // Format 2 carries its version in the signature. A file with any other
  // signature (here the unversioned "CELLUCID_SESSION\n") is refused with the
  // one sentence naming the expected format; nothing of it is restored.
  const productErrors = observeProductErrors(page);
  await recordNotifications(page);
  await openDataset(page);
  await poseCamera(page);
  const orbit = await readLiveOrbit(page);
  const current = await saveSession(page, testInfo, 'current.cellucid-session');
  const signature = Buffer.from('CELLUCID_SESSION/2\n');
  expect(current.subarray(0, signature.length).equals(signature)).toBe(true);
  const unversioned = Buffer.concat([
    Buffer.from('CELLUCID_SESSION\n'),
    current.subarray(signature.length),
  ]);
  await forgetNotifications(page);
  await loadSessionFile(page, 'unversioned.cellucid-session', unversioned);
  await expectAnnounced(
    page,
    ({ message }) => message.includes(NOT_A_SESSION_FILE_MESSAGE),
    1,
    'the file is refused once, naming the expected format',
  );
  expect((await publishedNotifications(page)).filter(restored)).toEqual([]);
  expect(await readLiveOrbit(page)).toEqual(orbit);
  expect(productErrors.filter(line => !line.includes(NOT_A_SESSION_FILE_MESSAGE))).toEqual([]);
});
