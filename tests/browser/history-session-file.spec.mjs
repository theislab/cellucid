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
import { sessionManifest, shownDomainValue } from './helpers/session-files.mjs';
import { clickSaveSession, clickLoadSession } from './helpers/session-buttons.mjs';

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
  const field = page.locator('#categorical-field');
  await field.selectOption({ label: 'cell_type' });
  await expect.poll(() => activeField(page)).toBe('cell_type');
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
  expect(JSON.stringify(await shownDomainValue(bytes, 'active-field'))).toContain('"cell_type"');

  // Another page: the dataset as it opens, then the session loaded.
  await openDataset(page);
  expect(await activeField(page)).not.toBe('cell_type');
  await loadSession(page, 'history.cellucid-session', bytes);
  await expect.poll(() => messages(page), { timeout: 60_000 }).toContain(RESTORED);
  expect(await activeField(page)).toBe('cell_type');
  // Its trackers are added beside the page's own (named apart), the file's active one shown (History v2 Q2).
  expect(await shownSteps(page)).toEqual({ labels: first.labels, trackers: [...first.trackers, ...first.trackers.map(name => `${name} (shared)`), 'Second look'] });
  // Its steps undo as they did where it was saved.
  await page.evaluate(() => window._cellucidHistories.current().undo());
  await expect.poll(() => activeField(page)).not.toBe('cell_type');
  await page.evaluate(() => window._cellucidHistories.current().redo());
  await expect.poll(() => activeField(page)).toBe('cell_type');
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
