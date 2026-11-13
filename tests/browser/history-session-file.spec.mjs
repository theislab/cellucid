/**
 * A session file is the dataset's history (session format 4): Save writes
 * every tracker with its steps and values, and Load, in another page, puts
 * the whole history back at its active step: the state shown, every step to
 * undo to, a second tracker. The file names its dataset, holds no
 * conversation unless asked, and a format-3 file is refused naming its
 * version, changing nothing.
 */
import { readFile } from 'node:fs/promises';

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { sessionManifest, shownDomainValue, withStatePartThisVersionLacks } from './helpers/session-files.mjs';
import { clickSaveSession, clickLoadSession } from './helpers/session-buttons.mjs';
import { createDrag, dragAndDrop } from './helpers/dataset-drop.mjs';
import { SAMPLE_CATALOG, START, TRAJECTORY } from './helpers/dataset-loading.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=history-session-file-ci`;
const RESTORED = 'Session fully restored.';

function productErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  // The dataset's history begins once its starting view is applied.
  await expect.poll(() => page.evaluate(() => window._cellucidHistories.current()?.active != null)).toBe(true);
}

/** The step labels of the tracker shown, root first, and its head. */
function shownSteps(page) {
  return page.evaluate(() => {
    const tracker = window._cellucidHistories.current().active;
    const labels = [];
    for (let step = tracker.steps.get(tracker.headId); step; step = step.parent === null ? null : tracker.steps.get(step.parent)) labels.unshift(step.label);
    return { labels, trackers: window._cellucidHistories.current().trackers().map(each => each.name) };
  });
}

function activeField(page) {
  return page.evaluate(() => window._cellucidState.getActiveField()?.key ?? null);
}

async function saveSession(page, testInfo, name) {
  const downloadPromise = page.waitForEvent('download');
  await clickSaveSession(page);
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath(name);
  await download.saveAs(sessionPath);
  return readFile(sessionPath);
}

async function loadSession(page, name, bytes) {
  const chooserPromise = page.waitForEvent('filechooser');
  await clickLoadSession(page);
  await (await chooserPromise).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
}

function messages(page) {
  return page.evaluate(() => [...document.querySelectorAll('.notification-message')].map(element => element.textContent.trim()));
}

test('a saved history loads in another page at its active step, with every step and tracker', async ({ page }, testInfo) => {
  const errors = productErrors(page);
  await openDataset(page);
  // It opens colored by cell_type (its first coloring, part of the opening): score is the step.
  await expect.poll(() => activeField(page)).toBe('cell_type');
  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await expect.poll(() => activeField(page)).toBe('score');
  await page.evaluate(() => window._cellucidHistories.current().reconcile());
  const first = await shownSteps(page);
  expect(first.labels.length).toBeGreaterThan(1);
  // A second tracker, started on what is shown, then the first shown again.
  await page.evaluate(async () => {
    const history = window._cellucidHistories.current();
    const mine = history.active.id;
    await history.startTracker({ name: 'Second look' });
    await history.useTracker(mine);
  });
  const bytes = await saveSession(page, testInfo, 'history.cellucid-session');
  const manifest = await sessionManifest(bytes);
  expect(manifest.trackers.map(tracker => tracker.name)).toEqual([...first.trackers, 'Second look']);
  expect(manifest.trackers.every(tracker => tracker.chats.length === 0)).toBe(true);
  expect(manifest.source).toEqual({ kind: 'sample', dataset: 'current-ui' });
  expect(JSON.stringify(await shownDomainValue(bytes, 'active-field'))).toContain('"score"');

  // Another page: the dataset as it opens, then the session loaded.
  await openDataset(page);
  expect(await activeField(page)).toBe('cell_type');
  await loadSession(page, 'history.cellucid-session', bytes);
  await expect.poll(() => messages(page), { timeout: 60_000 }).toContain(RESTORED);
  expect(await activeField(page)).toBe('score');
  // Its trackers are added beside the page's own (named apart), the file's active one shown.
  expect(await shownSteps(page)).toEqual({ labels: first.labels, trackers: [...first.trackers, ...first.trackers.map(name => `${name} (shared)`), 'Second look'] });
  // Its steps undo as they did where it was saved.
  await page.evaluate(() => window._cellucidHistories.current().undo());
  await expect.poll(() => activeField(page)).toBe('cell_type');
  await page.evaluate(() => window._cellucidHistories.current().redo());
  await expect.poll(() => activeField(page)).toBe('score');
  expect(errors).toEqual([]);
});

test('a session file dropped on the page loads as Load… does: its dataset opens with it, its history beside', async ({ page }, testInfo) => {
  const errors = productErrors(page);
  const sample = id => `/?sampleCatalog=${encodeURIComponent(SAMPLE_CATALOG)}&dataset=${id}&acceptance=history-session-file-ci`;
  const pages = () => page.evaluate(() => window._cellucidState.getHighlightPages().map(each => each.name));
  await page.goto(sample(START.id), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(START.name, { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => window._cellucidHistories.current()?.active != null)).toBe(true);
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    await getActions().dispatch('highlight.page.create', { name: 'From a colleague' });
  });
  await openCollapsedPanels(page);
  const bytes = await saveSession(page, testInfo, 'colleague.cellucid-session');
  // Another dataset is shown, as a colleague's would be when the file arrives by email.
  await page.goto(sample(TRAJECTORY.id), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(TRAJECTORY.name, { timeout: 60_000 });
  expect(await pages()).not.toContain('From a colleague');
  await dragAndDrop(page, await createDrag(page, { files: [{ name: 'colleague.cellucid-session', base64: bytes.toString('base64') }] }));
  // Its dataset opens, then its history loads: no "open its dataset first", nothing refused.
  await expect(page.locator('#dataset-name')).toHaveText(START.name, { timeout: 60_000 });
  await expect.poll(() => messages(page), { timeout: 60_000 }).toContain(RESTORED);
  expect(await pages()).toContain('From a colleague');
  expect((await messages(page)).filter(text => /Cannot open|Open its dataset, then/.test(text))).toEqual([]);
  expect(errors).toEqual([]);
});

test('a format-3 session file is refused naming its version, and nothing changes', async ({ page }, testInfo) => {
  const errors = productErrors(page);
  await openDataset(page);
  const bytes = await saveSession(page, testInfo, 'current.cellucid-session');
  const before = await shownSteps(page);
  const format3 = Buffer.concat([Buffer.from('CELLUCID_SESSION/3\n'), bytes.subarray('CELLUCID_SESSION/4\n'.length)]);
  await loadSession(page, 'format3.cellucid-session', format3);
  await expect.poll(() => messages(page)).toContainEqual(expect.stringMatching(
    /^This session was saved by an earlier version of Cellucid \(session format 3\), which this version no longer reads/,
  ));
  expect(await shownSteps(page)).toEqual(before);
  expect(errors.filter(line => !line.includes('session format 3'))).toEqual([]);
});

test('a file from a newer Cellucid with a part of the state this version lacks is restored but for that part, named', async ({ page }, testInfo) => {
  const errors = productErrors(page);
  await openDataset(page);
  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await expect.poll(() => activeField(page)).toBe('score');
  await page.evaluate(() => window._cellucidHistories.current().reconcile());
  const saved = await shownSteps(page);
  const newer = await withStatePartThisVersionLacks(await saveSession(page, testInfo, 'mine.cellucid-session'));
  await openDataset(page);
  await loadSession(page, 'newer.cellucid-session', newer);
  await expect.poll(() => messages(page), { timeout: 60_000 }).toContainEqual(expect.stringMatching(
    /^Session restored but for 1 part\. A part of the state this version of Cellucid does not have \("holograms"\) is left out: it was saved by a newer version of Cellucid \(99\.0\.0\)\./,
  ));
  expect(await activeField(page)).toBe('score');
  expect((await shownSteps(page)).labels).toEqual(saved.labels);
  expect(await page.evaluate(() => [...window._cellucidHistories.current().active.steps.values()].some(step => step.touches.includes('holograms')))).toBe(false);
  // The notice is a warning, never "fully restored"; the console says it once as a warning, no error.
  expect(await messages(page)).not.toContain(RESTORED);
  expect(errors).toEqual([]);
});
