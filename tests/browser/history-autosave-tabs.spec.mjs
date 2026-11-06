/**
 * The autosave over the browser's own IndexedDB, Web Locks and
 * BroadcastChannel, in two tabs of one browser (History v2 §3.7; run in
 * Chromium, Firefox and WebKit):
 *
 * - a tab holds a Web Lock on the saved state it writes; another tab is told
 *   the history is open there, and continuing it opens a copy, so the two
 *   never write one saved state;
 * - a write, a rename or a removal in one tab updates the other's lists;
 * - a million-cell brush is kept in the cell-set encoding and reads back
 *   exactly;
 * - a conversation that made no step is kept, and offered back after the
 *   page is reloaded.
 *
 * The history is the persistence tests' records history
 * (`tests/helpers/history-records.mjs`), so this measures the browser's
 * storage, not the history controller (whose specs drive the real page).
 */
import { closePageWithApplicationRetirement, expect, test } from './helpers/test.mjs';

const HOST = '/tests/browser/fixtures/webgl-harness.html';

/** Run `work` in a tab with the autosave modules loaded (as `window.kit`). */
async function openTab(context) {
  const page = await context.newPage();
  await page.goto(HOST);
  await page.evaluate(async () => {
    const autosave = await import('/assets/js/app/history/autosave.js');
    const store = await import('/assets/js/app/history/autosave-store.js');
    const records = await import('/tests/helpers/history-records.mjs');
    const history = await records.recordsHistory();
    const writes = [];
    const instance = autosave.createAutosave({
      history, dataset: { id: 'demo', name: 'Demo' }, header: async () => records.HEADER,
      schedule: write => writes.push(write),
    });
    let told = 0;
    autosave.onSavedStatesChange(() => { told += 1; });
    window.kit = {
      autosave, store, records, history, instance,
      told: () => told,
      async run() {
        while (writes.length > 0) writes.shift()();
        await instance.flush();
      },
    };
  });
  return page;
}

test.beforeEach(async ({ page }) => {
  await page.goto(HOST);
  await page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.deleteDatabase('cellucid-history');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  }));
});

test('a saved state is written by one tab: another is told it is open there, and continuing opens a copy', async ({ context }) => {
  const a = await openTab(context);
  const b = await openTab(context);
  const id = await a.evaluate(async () => {
    await window.kit.history.step({ colors: { by: 'leiden' } });
    await window.kit.run();
    return window.kit.instance.entryId;
  });
  expect(id).not.toBeNull();
  // B's list heard A's write (BroadcastChannel).
  await expect.poll(() => b.evaluate(() => window.kit.told())).toBeGreaterThan(0);
  expect(await b.evaluate(async () => (await window.kit.autosave.listSavedStates()).map(state => state.id))).toEqual([id]);
  expect(await b.evaluate(async () => (await navigator.locks.query()).held.map(lock => lock.name))).toContain(`cellucid-history/${id}`);
  const offer = await b.evaluate(async () => {
    const shown = [];
    await window.kit.instance.offerContinue({ notifications: { show: notice => { shown.push(notice); return 'n'; } }, onContinue: () => {} });
    return { message: shown[0].message, action: shown[0].action.label };
  });
  expect(offer.message).toMatch(/open in another tab/);
  expect(offer.action).toBe('Open a copy here');
  const continued = await b.evaluate(async savedId => {
    const kit = window.kit;
    return kit.instance.continueFrom({ id: savedId, createdAt: 0 }, async () => {
      const source = await kit.autosave.openSavedState(savedId);
      const eager = await source.readEager();
      const rest = await source.readRest();
      for (const [hash, value] of [...eager.values, ...rest.values]) kit.history.pool.adopt(hash, value);
      kit.history.load(eager.history.trackers);
    });
  }, id);
  expect(continued).toBe(false);
  const copy = await b.evaluate(async () => {
    await window.kit.history.step({ colors: { by: 'B' } });
    await window.kit.run();
    return window.kit.instance.entryId;
  });
  expect(copy).not.toBe(id);
  // A closed tab lets its saved state go: a new tab continues it itself.
  await a.evaluate(() => window.kit.instance.retire());
  await closePageWithApplicationRetirement(a);
  await expect.poll(() => b.evaluate(async () => (await navigator.locks.query()).held.map(lock => lock.name))).not.toContain(`cellucid-history/${id}`);
});

test('a removal in one tab updates the other\'s list', async ({ context }) => {
  const a = await openTab(context);
  const b = await openTab(context);
  const id = await a.evaluate(async () => {
    window.kit.history.note('Why');
    await window.kit.run();
    return window.kit.instance.entryId;
  });
  await expect.poll(() => b.evaluate(async () => (await window.kit.autosave.listSavedStates()).length)).toBe(1);
  const before = await a.evaluate(() => window.kit.told());
  expect(await b.evaluate(savedId => window.kit.autosave.removeSavedStates([savedId]), id)).toBe(1);
  await expect.poll(() => a.evaluate(() => window.kit.told())).toBeGreaterThan(before);
  expect(await a.evaluate(async () => (await window.kit.autosave.listSavedStates()).length)).toBe(0);
});

test('a million-cell brush is kept in the cell-set encoding and reads back exactly', async ({ context }) => {
  const a = await openTab(context);
  const result = await a.evaluate(async () => {
    const kit = window.kit;
    const cells = Uint32Array.from({ length: 1_000_000 }, (_, i) => i).filter(i => i % 1000 !== 7);
    await kit.history.step({ highlights: { groups: [{ label: 'Most', cells }] } });
    await kit.run();
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('cellucid-history');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const arrays = await new Promise((resolve, reject) => {
      const request = db.transaction('arrays').objectStore('arrays').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const brush = arrays.find(record => record.encoding === 'cell-set');
    const source = await kit.autosave.openSavedState(kit.instance.entryId);
    const eager = await source.readEager();
    const rest = await source.readRest();
    const kept = [...eager.values.values(), ...rest.values.values()].find(value => value?.groups?.[0]?.label === 'Most');
    let same = kept.groups[0].cells.length === cells.length;
    for (let i = 0; same && i < cells.length; i++) same = kept.groups[0].cells[i] === cells[i];
    return { stored: brush?.data.byteLength ?? null, raw: cells.byteLength, same };
  });
  expect(result.same).toBe(true);
  expect(result.stored).not.toBeNull();
  expect(result.stored).toBeLessThan(result.raw / 100);
});

test('a conversation that made no step is kept and offered back after a reload', async ({ context }) => {
  const a = await openTab(context);
  await a.evaluate(async () => {
    window.kit.history.chat('c1', [{ role: 'user', text: 'What is in this dataset?' }, { role: 'assistant', parts: [{ type: 'text', text: '1000 cells' }] }]);
    await window.kit.run();
    await window.kit.instance.retire();
  });
  await a.reload();
  await a.goto(HOST);
  const b = await openTab(context);
  const offer = await b.evaluate(async () => {
    const shown = [];
    await window.kit.instance.offerContinue({ notifications: { show: notice => { shown.push(notice); return 'n'; } }, onContinue: () => {} });
    return shown[0]?.message ?? null;
  });
  expect(offer).toMatch(/Continue where you left off\? .*1 conversation/);
});
