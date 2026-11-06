/**
 * A session restores in an engine other than the one that saved it, and a
 * restore announces its outcome once — except a sample's own view, which is
 * part of opening the sample and restores without a word.
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
 * well: by the restore's progress entry and by "Sample view unavailable". A
 * published sample view that applies says nothing: the person opened a
 * sample, not a session, so its camera landing is the only sign.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';
import { cameraStatesIn, rewriteShownValue, sessionManifest, startingViewBytes } from './helpers/session-files.mjs';
import { NOT_A_SESSION_FILE_MESSAGE, otherSessionFormatMessage } from '../../assets/js/app/session/bundle/format.js';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { clickSaveSession, clickLoadSession } from './helpers/session-buttons.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=session-restore-portability-ci';

const CATALOG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'catalog',
  'datasets.json',
);

const RESTORED = 'Session fully restored.';

// Errors of the page. The loads its navigations stop in the document they
// leave never reach these listeners (`helpers/leaving-document.mjs`).
function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/** Open the start dataset. */
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
  await clickSaveSession(page);
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath(name);
  await download.saveAs(sessionPath);
  return readFile(sessionPath);
}

/** One unit in the last place, away from zero. */
function nextUp(value) {
  return value === 0 ? Number.MIN_VALUE : value * (1 + Number.EPSILON);
}

/**
 * A saved session whose shown values are edited (`edits`: domain id → edit
 * of a copy of its value) and, with `startingView`, published as the
 * dataset's starting view (`helpers/session-files.mjs`).
 */
async function rewriteSession(bytes, edits, { startingView = false } = {}) {
  let rewritten = bytes;
  for (const [domain, edit] of Object.entries(edits)) rewritten = await rewriteShownValue(rewritten, domain, edit);
  return startingView ? startingViewBytes(rewritten) : rewritten;
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

/** Every camera state the views and the cameras hold, each moved as another engine derives it. */
const moveDerivedCameraBits = Object.freeze({
  views: value => cameraStatesIn(value).forEach(deriveInAnotherEngine),
  camera: value => cameraStatesIn(value).forEach(deriveInAnotherEngine),
});

/** A select setting given a value its control does not offer; false when the value holds none. */
function breakFirstSelect(value) {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return false;
  if (value.type === 'select' && typeof value.value === 'string') {
    value.value = 'not-an-offered-option';
    return true;
  }
  return Object.values(value).some(breakFirstSelect);
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
  await clickLoadSession(page);
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
  // Load State used to add a third announcement of the same event. The one other notice is the
  // offer to undo the load (its trackers were added beside the ones shown).
  expect(await publishedNotifications(page)).toEqual([
    { title: 'Loaded', message: RESTORED },
    { title: '', message: 'Loaded "Tracker 1 (shared)" from other-engine.cellucid-session beside yours.' },
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
  await clickLoadSession(page);
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
  await clickLoadSession(page);
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
  expect((await sessionManifest(sampleSession)).source).toEqual({
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
  expect((await sessionManifest(linkSession)).source).toEqual({
    kind: 'link',
    locator: link,
    dataset: expect.any(String),
  });

  await openDataset(page);
  await page.locator('#dataset-select').selectOption('__none__');
  await forgetNotifications(page);
  await loadSessionFile(page, 'link.cellucid-session', linkSession);
  await expectAnnounced(page, restored, 1, 'the link reopens and restores');
  await expect(page.locator('#data-address')).toHaveValue(link);
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

test('a published sample view saved by another engine applies, without a word', async ({
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
    { startingView: true },
  );
  await servePublishedDefault(page, stateBytes);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('html')).toHaveAttribute(
    'data-startup-phase',
    'ready',
  );
  await expect.poll(
    () => readLiveOrbit(page),
    { message: 'the sample view moves the camera to its saved pose' },
  ).toEqual(savedOrbit);
  const published = await publishedNotifications(page);
  expect(
    published.filter(restored),
    'a sample view is part of opening the sample, not a session to announce',
  ).toEqual([]);
  expect(published.filter(sampleViewUnavailable)).toEqual([]);
  expect(published.filter(loadingFailed)).toEqual([]);
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
    {
      // A select value the control does not offer: refused when the settings
      // are put back, after the file has been read.
      settings: value => { rewroteSelect = breakFirstSelect(value); },
    },
    { startingView: true },
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

test('a published sample view of another session format: the dataset opens on its default view, with one short line', async ({
  page,
}, testInfo) => {
  // The app and the datasets are deployed minutes apart: a new app meets an
  // old view, or a cached app a new one. No format is read but this one, and
  // nothing about formats reaches the person.
  const productErrors = observeProductErrors(page);
  await recordNotifications(page);
  await openDataset(page);
  const current = await saveSession(page, testInfo, 'current.cellucid-session');
  const signature = Buffer.from('CELLUCID_SESSION/4\n');
  expect(current.subarray(0, signature.length).equals(signature)).toBe(true);
  for (const prefix of ['CELLUCID_SESSION/3\n', 'CELLUCID_SESSION/9\n']) {
    await page.unrouteAll({ behavior: 'wait' });
    await servePublishedDefault(page, Buffer.concat([Buffer.from(prefix), current.subarray(signature.length)]));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await openCollapsedPanels(page);
    await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
    await expectAnnounced(
      page,
      ({ message }) => /starting view isn\u2019t available right now/.test(message),
      1,
      `${prefix.trim()}: one short line`,
    );
    const published = await publishedNotifications(page);
    expect(published.filter(sampleViewUnavailable)).toEqual([]);
    expect(published.filter(loadingFailed)).toEqual([]);
    expect(published.filter(({ message }) => /session format|earlier version|newer version/i.test(message))).toEqual([]);
    await expect(page.locator('#notification-center .notification-error')).toHaveCount(0);
    // The dataset's history starts from what is shown, after the line is said.
    await expect.poll(() => page.evaluate(() => window._cellucidHistories?.current()?.active != null)).toBe(true);
  }
  expect(productErrors).toEqual([]);
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
    {},
    { startingView: true },
  );
  await servePublishedDefault(page, stateBytes);

  const link = `${SAMPLE_ORIGIN}/tests/browser/fixtures/catalog/`;
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(link)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect.poll(
    () => readLiveOrbit(page),
    { message: 'the linked catalog applies its starting view' },
  ).toEqual(savedOrbit);
  expect(
    (await publishedNotifications(page)).filter(restored),
    'a starting view restores without a word',
  ).toEqual([]);
  expect(productErrors).toEqual([]);
});

test('a file without the format-4 signature is refused, and nothing changes', async ({
  page,
}, testInfo) => {
  // Format 4 carries its version in the signature. A session of format 3
  // (saved by an earlier Cellucid: one state, not the history of its steps)
  // is refused naming its format; a file with any other signature (here the
  // unversioned "CELLUCID_SESSION\n") with the one sentence naming the
  // expected format. Nothing of either is restored.
  const productErrors = observeProductErrors(page);
  await recordNotifications(page);
  await openDataset(page);
  await poseCamera(page);
  const orbit = await readLiveOrbit(page);
  const current = await saveSession(page, testInfo, 'current.cellucid-session');
  const signature = Buffer.from('CELLUCID_SESSION/4\n');
  expect(current.subarray(0, signature.length).equals(signature)).toBe(true);
  const refusals = [
    ['format3.cellucid-session', 'CELLUCID_SESSION/3\n', otherSessionFormatMessage(3)],
    ['unversioned.cellucid-session', 'CELLUCID_SESSION\n', NOT_A_SESSION_FILE_MESSAGE],
  ];
  for (const [name, prefix, sentence] of refusals) {
    const other = Buffer.concat([Buffer.from(prefix), current.subarray(signature.length)]);
    await forgetNotifications(page);
    await loadSessionFile(page, name, other);
    await expectAnnounced(
      page,
      ({ message }) => message.includes(sentence),
      1,
      `${name} is refused once, naming the format`,
    );
    expect((await publishedNotifications(page)).filter(restored)).toEqual([]);
    expect(await readLiveOrbit(page)).toEqual(orbit);
  }
  expect(productErrors.filter(line => !refusals.some(([, , sentence]) => line.includes(sentence)))).toEqual([]);
});
