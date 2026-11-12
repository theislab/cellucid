/**
 * Sharing a history (History v2 §6 test 11), in the page, through the one
 * share action every caller uses (`history.share`: the Share dialog, an
 * agent, Python and R):
 *
 * - each form writes exactly what was chosen: the trackers and branches, the
 *   current state only (one tracker of the opening and one squashed step),
 *   the steps only (no value, results run again), with or without notes and
 *   times;
 * - a file of steps only opens as a replay: a tracker of its own, its steps
 *   applied again here;
 * - a history file loads beside the person's trackers, leaving each of them
 *   exactly as it was, and one Undo removes what it added to Recently deleted.
 *
 * The receiver's workflow banner is the State panel's (H3) and is walked by
 * its own spec once the panel lands.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { takeSteps, waitForHistory } from './helpers/state-history.mjs';
import { playAnthropic } from './helpers/agent-chat.mjs';
import { observeProductErrors } from './helpers/history-hunt.mjs';
import { sessionManifest } from './helpers/session-files.mjs';
import { clickLoadSession } from './helpers/session-buttons.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=history-share`;
const CELL_TYPE = Object.freeze({ source: 'obs', key: 'cell_type' });
/** What the steps color by: the dataset opens colored by cell_type (its first coloring), so score is a step. */
const SCORE = Object.freeze({ source: 'obs', key: 'score' });
const RESTORED = 'Session fully restored.';
const REPLAYED = 'Session steps replayed.';

async function open(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
}

/** A history worth sharing: two branches of the first tracker, a note, and a second tracker. */
async function buildHistory(page) {
  await takeSteps(page, [
    ['color.by', { field: SCORE }],
    ['filter.category.visibility', { field: CELL_TYPE, categories: ['gamma'], visible: false }],
  ]);
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const history = window._cellucidHistories.current();
    const tree = history.active;
    await getActions().dispatch('history.note.add', { target: { tracker: tree.id }, text: 'Why gamma is hidden' });
    const [first] = tree.steps.get(tree.rootId).children;
    await history.jump(first);
    await getActions().dispatch('setting.set', { setting: 'point-size', value: 21 });
    await history.startTracker({ name: 'Second' });
    await getActions().dispatch('setting.set', { setting: 'point-size', value: 9 });
    await history.idle();
  });
}

/** Share through the action; the file it downloads and what the action answered. */
async function share(page, params) {
  const downloadPromise = page.waitForEvent('download');
  const answer = await page.evaluate(async given => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    return (await getActions().dispatch('history.share', given)).outcome;
  }, params);
  const download = await downloadPromise;
  const { readFile } = await import('node:fs/promises');
  return { answer, bytes: await readFile(await download.path()) };
}

async function load(page, name, bytes) {
  const chooserPromise = page.waitForEvent('filechooser');
  await clickLoadSession(page);
  await (await chooserPromise).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
}

function messages(page) {
  return page.evaluate(() => [...document.querySelectorAll('.notification-message')].map(element => element.textContent.trim()));
}

/** Every live tracker: its id, name, head and each step with its values. */
function trackers(page) {
  return page.evaluate(() => window._cellucidHistories.current().trackers().map(tree => ({
    id: tree.id, name: tree.name, head: tree.headId,
    steps: [...tree.steps.values()].map(step => `${step.id}<${step.parent}:${step.label}:${JSON.stringify(step.after)}`),
  })));
}

test('each form writes exactly what was chosen: the trackers and branches, the state only, the steps only, notes and times', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = observeProductErrors(page);
  await open(page);
  await buildHistory(page);
  const ids = await page.evaluate(() => window._cellucidHistories.current().trackers().map(tree => ({ id: tree.id, name: tree.name })));

  // The whole history of both trackers, every branch of the first.
  const both = await share(page, { include: [{ tracker: ids[0].id, branches: ['b0', 'b1'] }, { tracker: ids[1].id }] });
  let manifest = await sessionManifest(both.bytes);
  expect(manifest.scope.content).toBe('history');
  expect(manifest.trackers.map(tracker => tracker.id)).toEqual(ids.map(tracker => tracker.id));
  expect(manifest.scope.branches.find(entry => entry.tracker === ids[0].id).branches).toEqual(['b0', 'b1']);
  expect(manifest.trackers[0].notes.map(note => note.text)).toEqual(['Why gamma is hidden']);
  expect(both.answer.trackers.map(tracker => tracker.name)).toEqual(ids.map(tracker => tracker.name));

  // Without notes, times or where the dataset opens from.
  const bare = await share(page, { notes: false, times: 'none', source: 'name' });
  manifest = await sessionManifest(bare.bytes);
  expect(manifest.trackers.map(tracker => tracker.id)).toEqual([ids[1].id]);
  expect(manifest.trackers[0].notes).toEqual([]);
  expect(manifest.trackers[0].createdAt).toBeNull();
  expect(manifest.createdAt).toBe('1970-01-01T00:00:00.000Z');
  expect(manifest.scope).toMatchObject({ notes: false, times: 'none', source: 'name' });

  // The current state only: one tracker of the opening and one squashed step, nobody named.
  const state = await share(page, { content: 'state' });
  manifest = await sessionManifest(state.bytes);
  expect(manifest.scope).toMatchObject({ content: 'state', notes: false, chats: false, journal: false, times: 'none' });
  expect(manifest.trackers).toHaveLength(1);
  expect(manifest.trackers[0].nextStep).toBe(2);
  expect(state.answer.steps).toBe(1);

  // The steps only: no value, results run again.
  const steps = await share(page, { content: 'steps' });
  manifest = await sessionManifest(steps.bytes);
  expect(manifest.scope).toMatchObject({ content: 'steps', results: 'recompute' });
  expect(manifest.chunks.filter(chunk => chunk.kind === 'values')).toEqual([]);
  expect(errors).toEqual([]);
});

test('a file of the steps only opens as a replay: a tracker of its own, its steps applied again here', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = observeProductErrors(page);
  await open(page);
  await takeSteps(page, [['color.by', { field: SCORE }], ['setting.set', { setting: 'point-size', value: 17 }]]);
  const { bytes } = await share(page, { content: 'steps' });
  // Back to the opening, then the plan replayed: a tracker of its own, its steps applied again from the opening.
  await page.evaluate(async () => {
    const history = window._cellucidHistories.current();
    await history.jump(history.active.rootId);
    await history.idle();
  });
  const own = await page.evaluate(() => window._cellucidHistories.current().active.id);
  await load(page, 'plan.cellucid-session', bytes);
  await expect.poll(() => messages(page), { timeout: 60_000 }).toContain(REPLAYED);
  const after = await page.evaluate(() => {
    const history = window._cellucidHistories.current();
    return {
      active: history.active.id, start: history.active.start.kind, steps: history.active.steps.size,
      pointSize: document.querySelector('#point-size').value, trackers: history.trackers().map(tracker => tracker.id),
    };
  });
  expect(after.trackers).toContain(own);
  expect(after.active).not.toBe(own);
  expect(after.start).toBe('replay');
  // Each step that changes something here is applied again (coloring by what the opening already shows is not).
  expect(after.steps).toBeGreaterThanOrEqual(2);
  expect(after.pointSize).toBe('17');
  expect(errors).toEqual([]);
});

test('a history file loads beside the person\'s trackers, leaving each exactly as it was; one Undo removes what it added', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = observeProductErrors(page);
  await open(page);
  await buildHistory(page);
  const { bytes } = await share(page, {});
  // The person goes on after sharing.
  await takeSteps(page, [['setting.set', { setting: 'point-size', value: 33 }]]);
  const own = await trackers(page);
  await load(page, 'shared.cellucid-session', bytes);
  await expect.poll(() => messages(page), { timeout: 60_000 }).toContain(RESTORED);
  const loaded = await trackers(page);
  expect(loaded).toHaveLength(own.length + 1);
  // The person's own trackers are exactly as they were.
  for (const tracker of own) expect(loaded.find(each => each.id === tracker.id)).toEqual(tracker);
  const added = loaded.find(each => !own.some(tracker => tracker.id === each.id));
  expect(added.name).toBe('Second (shared)');
  // One Undo: what the load added goes to Recently deleted; the person's trackers stay.
  const offer = page.locator('.notification').filter({ hasText: 'beside yours' });
  await offer.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await trackers(page)).map(tracker => tracker.id)).toEqual(own.map(tracker => tracker.id));
  for (const tracker of own) expect((await trackers(page)).find(each => each.id === tracker.id)).toEqual(tracker);
  const removed = await page.evaluate(id => window._cellucidHistories.current().allTrackers().find(tree => tree.id === id)?.removed !== null, added.id);
  expect(removed).toBe(true);
  expect(errors).toEqual([]);
});

/** Every record of this browser's saved states (`cellucid-history`), as text: JSON, and the bytes each array holds. */
function historyDatabaseText(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('cellucid-history');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const names = [...db.objectStoreNames];
      const tx = db.transaction(names, 'readonly');
      const texts = [];
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const asText = value => JSON.stringify(value, (key, item) => (ArrayBuffer.isView(item) ? decoder.decode(new Uint8Array(item.buffer, item.byteOffset, item.byteLength)) : item));
      for (const name of names) {
        const cursor = tx.objectStore(name).openCursor();
        cursor.onsuccess = () => {
          if (cursor.result === null) return;
          texts.push(asText(cursor.result.key), asText(cursor.result.value));
          cursor.result.continue();
        };
      }
      tx.oncomplete = () => { db.close(); resolve(texts.join('\n')); };
      tx.onerror = () => reject(tx.error);
    };
  }));
}

test('an API key typed in the chat is in no file written and in no record this browser keeps (review S6)', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = observeProductErrors(page);
  const KEY = 'sk-ant-api03-H2REVIEW-never-written-0123456789abcdef';
  // A key is sent to its provider to list its models, and nowhere else: the provider is played here.
  const api = await playAnthropic(page);
  await open(page);
  await page.locator('#agent-chat-toggle').click();
  await expect(page.locator('#agent-chat-settings')).toBeVisible();
  await page.locator('#agent-chat-key').fill(KEY);
  await page.locator('#agent-chat-key').dispatchEvent('change');
  await expect.poll(() => api.requests.map(request => [request.path, request.key])).toEqual([['/v1/models', KEY]]);
  await buildHistory(page);
  await page.evaluate(async () => {
    await window._cellucidHistories.flush();
    await window._cellucidHistories.savedStates.saveAs('With a key typed');
  });
  const files = [];
  for (const params of [{}, { content: 'state' }, { content: 'steps' }, { chats: true }]) files.push((await share(page, params)).bytes);
  for (const bytes of files) expect(bytes.includes(Buffer.from(KEY))).toBe(false);
  const database = await historyDatabaseText(page);
  expect(database.length).toBeGreaterThan(0);
  expect(database.includes(KEY)).toBe(false);
  // The key is where the chat keeps it (this tab), and only there.
  expect(await page.evaluate(key => Object.values(sessionStorage).includes(key), KEY)).toBe(true);
  expect(errors).toEqual([]);
});
