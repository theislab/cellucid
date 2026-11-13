/**
 * Session › Open data › Stored and its dialog (`ui/modules/kept-stores-line.js`,
 * `ui/modules/kept-stores-dialog.js`).
 *
 * - The row sums up what is kept ("2 datasets · … kept"); Manage… opens the
 *   dialog, which lists each dataset by its file's name and host with a row
 *   per kind kept; a row an open tab uses cannot be ticked.
 * - Downloaded parts say what they save the next opening. The connection
 *   speeds remembered per host are one row with its own Remove, and Remove
 *   all forgets them too.
 * - Ticked rows go with Remove selected, one dataset with its Remove; the
 *   row and the dialog follow. Escape closes the dialog and gives the focus
 *   back to Manage….
 * - Where it's kept names this site's private storage, the browser's figures
 *   and whether it keeps it when space is low.
 * - My datasets (the dataset the address opened is listed) is one row, never
 *   a row per dataset (`my-datasets.spec.mjs`); Remove all forgets it too.
 * - What other code kept (a directory whose manifest carries another code
 *   fingerprint) is never listed or counted, and the app removes it, of every
 *   kind, when it starts; what this code kept stays.
 *
 * What is kept is written as the keepers write it (`transcode/space.js`
 * manifests), so the spec needs no large file.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { keptStoreDirectories } from './helpers/origin-storage.mjs';

const START_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=kept-stores-dialog`;

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/** Whether this window gives the site an origin private file system it can write from a page. */
async function pageWritesStorage(page) {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('kept-stores-dialog-probe', { create: true });
      const handle = await folder.getFileHandle('probe', { create: true });
      if (typeof handle.createWritable !== 'function') return false;
      const writable = await handle.createWritable();
      await writable.close();
      await root.removeEntry('kept-stores-dialog-probe', { recursive: true });
      return true;
    } catch {
      return false;
    }
  });
}

/** Remember two hosts' connection speeds as `data/host-link-memory.js` does. */
async function rememberHosts(page) {
  // Overwrites what opening the sample measured of its own host.
  await page.evaluate(() => {
    localStorage.setItem('cellucid:host-link:v1', JSON.stringify({
      'https://datasets.example.org': { latencyMs: 244, bytesPerMs: 1_572.864, evidenceBytes: 50_000_000, at: Date.now() },
      'http://127.0.0.1:8765': { latencyMs: 2, bytesPerMs: 104_857.6, evidenceBytes: 9_000_000, at: Date.now() - 1000 },
    }));
  });
}

/** Keep items as the keepers do: two datasets, one of them with three kinds, one row held by this tab. */
async function keepItems(page) {
  await page.evaluate(async () => {
    const space = await import('/assets/js/data/anndata/transcode/space.js');
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle(space.TRANSCODED_DIRECTORY, { create: true });
    const now = Date.now();
    const items = [
      // Kept by other code (another code fingerprint): never listed or counted.
      { dir: 'k0', key: 'f'.repeat(64), source: 'f'.repeat(64), about: { name: 'kept-by-other-code.rds', host: null }, bytes: 7 * 1_048_576, otherCode: true },
      { dir: 'k1', key: 'a'.repeat(64), source: 'a'.repeat(64), about: { name: 'pbmc3k.rds', host: null }, bytes: 3 * 1_048_576 },
      { dir: 'k2', kind: 'download', key: 'b'.repeat(64), source: 'c'.repeat(64), about: { name: 'atlas.h5ad', host: 'example.org' }, bytes: 5 * 1_048_576 },
      { dir: 'k3', kind: 'column-index', key: 'd'.repeat(64), source: 'c'.repeat(64), about: { name: 'atlas.h5ad', host: 'example.org', matrix: 'X', order: { order: 'file' } }, bytes: 1_048_576 },
    ];
    for (const item of items) {
      const folder = await parent.getDirectoryHandle(item.dir, { create: true });
      const write = async (name, text) => {
        const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
        await writable.write(text);
        await writable.close();
      };
      await write('used', String(now));
      await write('manifest.json', JSON.stringify({
        ...(item.kind ? { kind: item.kind } : {}),
        whole: true,
        // Each kind is stamped with its own code fingerprint (`space.js`
        // `codeFingerprintOf`): a manifest stamped otherwise is removed, not listed.
        codeFingerprint: item.otherCode ? 'other code' : space.codeFingerprintOf(item),
        persist: true,
        key: item.key,
        source: item.source,
        about: item.about,
        blobs: { 'd.bin': item.bytes },
      }));
    }
    // Downloaded parts, kept as a reader worker keeps them (a journal,
    // `openKeptJournal`, written by a worker's synchronous access handles):
    // 2 MB on disk, sparing 2 MB of downloads next time.
    const keeper = new Worker(URL.createObjectURL(new Blob([`
      try {
        const space = await import('${location.origin}/assets/js/data/anndata/transcode/space.js');
        const identity = { parts: { kind: 'remote', key: 'url:atlas', version: 'census:1' }, size: 2 * 1048576 };
        const journal = await space.openKeptJournal(identity, { manifest: { kind: 'parts', source: '${'c'.repeat(64)}', about: { name: 'atlas.h5ad', host: 'example.org' }, size: 2 * 1048576 } });
        await journal.appendRange('', 0, new Uint8Array(2 * 1048576));
        journal.close();
        journal.release();
        postMessage(journal.directory);
      } catch (error) {
        postMessage('failed: ' + error.message);
      }
    `], { type: 'text/javascript' })), { type: 'module' });
    const kept = await new Promise(resolve => {
      keeper.onmessage = event => resolve(event.data);
    });
    keeper.terminate();
    if (String(kept).startsWith('failed')) throw new Error(`The parts were not kept: ${kept}`);
    // The gene index is in use by this tab: the row hears it.
    await space.holdTranscodedStore('k3');
  });
}

test('the Stored row sums up what is kept, and its dialog lists it by dataset and removes what is chosen', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  test.skip(!(await pageWritesStorage(page)), 'this window gives a page no storage it can write');
  // Nothing kept yet: the row is hidden, or names only the speed opening the sample measured of its host.
  const measured = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('cellucid:host-link:v1') ?? '{}')).length);
  if (measured === 0) await expect(page.locator('#kept-stores-line')).toBeHidden();
  else await expect(page.locator('#kept-stores-text')).toHaveText(`${measured} connection speed${measured === 1 ? '' : 's'}`);
  await rememberHosts(page);
  await keepItems(page);
  await expect(page.locator('#kept-stores-line')).toBeVisible();
  // One line beside Manage… naming the datasets; every kind in its title.
  await expect(page.locator('#kept-stores-text')).toHaveText('2 datasets · 11 MB kept');
  await expect(page.locator('#kept-stores-text')).toHaveAttribute('title', '2 datasets · 11 MB · 2 connection speeds');
  expect(await page.locator('#kept-stores-text').evaluate(text => text.getClientRects().length)).toBe(1);

  const manage = page.locator('#kept-stores-manage-btn');
  await manage.click();
  const dialog = page.locator('#kept-stores-dialog');
  await expect(dialog).toBeVisible();
  const sections = dialog.locator('.kept-dataset:not(.kept-hosts):not(.kept-library)');
  await expect(sections).toHaveCount(2);
  await expect(dialog).not.toContainText('kept-by-other-code.rds');
  await expect(dialog.locator('.kept-library .kept-dataset-facts')).toHaveText('1 dataset opened in this browser');
  const atlas = sections.filter({ hasText: 'atlas.h5ad' });
  await expect(atlas.locator('.kept-dataset-facts')).toHaveText('example.org · 8.0 MB');
  await expect(atlas.locator('.select-item-name')).toHaveText(['Downloaded parts', 'Gene index (X, every cell)', 'Whole download']);
  await expect(atlas.locator('[data-item-id^="parts:"]')).toContainText('saves 2.0 MB next open');
  const indexRow = atlas.locator('[data-item-id^="gene-index:"]');
  await expect(indexRow.locator('input')).toBeDisabled();
  await expect(indexRow).toContainText('in use by this tab');
  await expect(sections.filter({ hasText: 'pbmc3k.rds' }).locator('.kept-dataset-facts')).toHaveText('this computer · 3.0 MB');

  // The hosts whose connection speed is remembered: one row, its own Remove.
  const hosts = dialog.locator('.kept-hosts');
  await expect(hosts.locator('.kept-dataset-name')).toHaveText('Connection speeds remembered (2 hosts)');
  await expect(hosts.locator('.kept-dataset-facts')).toHaveText('datasets.example.org, 127.0.0.1:8765');
  await expect(hosts.locator('.kept-dataset-facts')).toHaveAttribute('title', 'datasets.example.org: 244 ms round trip, 1.5 MB/s\n127.0.0.1:8765: 2 ms round trip, 100 MB/s');
  await hosts.getByRole('button', { name: 'Forget the connection speeds of 2 hosts' }).click();
  await expect(page.locator('#kept-stores-status')).toHaveText('Forgot the connection speeds of 2 hosts.');
  await expect(hosts).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('cellucid:host-link:v1'))).toBeNull();

  // Where it's kept: this site's private storage, the browser's figures.
  const where = page.locator('#kept-stores-where');
  const host = await page.evaluate(() => location.host);
  await expect(where.locator('dt:text-is("Place") + dd')).toHaveText(`this browser's private storage for ${host}`);
  await expect(where.locator('dt:text-is("Removed by") + dd')).toHaveText("this dialog, or the browser's Clear site data");

  // Ticked rows go; the row in use stays.
  await expect(page.locator('#kept-stores-remove-selected')).toBeDisabled();
  await atlas.locator('[data-item-id]').filter({ hasText: 'Whole download' }).locator('input').check();
  await page.locator('#kept-stores-remove-selected').click();
  await expect(page.locator('#kept-stores-status')).toHaveText('Removed 1 item.');
  await expect(atlas.locator('[data-item-id]')).toHaveCount(2);
  await expect(page.locator('#kept-stores-text')).toHaveText('2 datasets · 6.0 MB kept');
  // One dataset's whole.
  await sections.filter({ hasText: 'pbmc3k.rds' }).getByRole('button', { name: 'Remove what is kept of pbmc3k.rds' }).click();
  await expect(sections).toHaveCount(1);
  // Remove all: everything no tab uses, and the connection speeds remembered since.
  await rememberHosts(page);
  await page.keyboard.press('Escape');
  await manage.click();
  await expect(hosts).toHaveCount(1);
  await page.locator('#kept-stores-remove-all').click();
  await expect(page.locator('#kept-stores-status')).toHaveText('Removed 1 item. Forgot 1 dataset of My datasets. Forgot the connection speeds of 2 hosts. 1 item in use by an open tab stays until that tab closes.');
  await expect(dialog.locator('.kept-library')).toHaveCount(0);
  await expect(hosts).toHaveCount(0);
  await expect(atlas.locator('[data-item-id]')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('cellucid:host-link:v1'))).toBeNull();
  await expect(page.locator('#kept-stores-dialog .kept-dataset').getByRole('button', { name: /^Remove what is kept of/ })).toBeDisabled();
  // Focus stays in the dialog; Escape closes it and gives it back to Manage….
  expect(await page.evaluate(() => document.getElementById('kept-stores-dialog').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(manage).toBeFocused();
  expect(errors).toEqual([]);
});

test.describe('in a window whose storage lasts', () => {
  // WebKit's ephemeral test contexts give a page no private storage (`helpers/test.mjs` `persistentStorage`).
  test.use({ persistentStorage: true });

  test('what other code kept is removed when the app starts, of every kind; what this code kept stays', async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
    test.skip(!(await pageWritesStorage(page)), 'this window gives a page no storage it can write');
    // One kept directory of every kind as other code left it, and one of this code's.
    await page.evaluate(async () => {
      const space = await import('/assets/js/data/anndata/transcode/space.js');
      const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle(space.TRANSCODED_DIRECTORY, { create: true });
      const keep = async (dir, said, codeFingerprint) => {
        const folder = await parent.getDirectoryHandle(dir, { create: true });
        const writable = await (await folder.getFileHandle('manifest.json', { create: true })).createWritable();
        await writable.write(JSON.stringify({ ...said, codeFingerprint, persist: true, key: dir.padEnd(64, '0'), source: 'e'.repeat(64), about: { name: `${dir}.h5ad`, host: null }, blobs: { 'd.bin': 1024 } }));
        await writable.close();
      };
      for (const [dir, said] of [['other-store', { whole: true }], ['other-download', { kind: 'download', whole: true }], ['other-index', { kind: 'column-index' }], ['other-parts', { kind: 'parts', journal: true }]]) {
        await keep(dir, said, 'other code');
      }
      await keep('mine-store', { whole: true }, space.codeFingerprintOf({}));
    });
    expect((await keptStoreDirectories(page)).filter(name => /^(other|mine)-/.test(name))).toEqual(['mine-store', 'other-download', 'other-index', 'other-parts', 'other-store']);
    // The next visit: the app's start removes what other code kept.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
    await expect.poll(async () => (await keptStoreDirectories(page)).filter(name => /^(other|mine)-/.test(name))).toEqual(['mine-store']);
    await expect(page.locator('#kept-stores-text')).toHaveText(/^1 dataset · 1\.0 KB kept/);
    expect(errors).toEqual([]);
  });
});

test('a saved state is listed under its dataset\'s name, and removed when chosen', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  // A window that keeps nothing says so on the row instead (covered by the last test).
  test.skip(!(await pageWritesStorage(page)), 'this window gives a page no storage that lasts');
  // The dataset's history has begun once it opened; a named save of it is kept at once.
  await expect.poll(() => page.evaluate(() => window._cellucidHistories.current()?.active !== null)).toBe(true);
  await page.evaluate(() => window._cellucidHistories.savedStates.saveAs('Probe'));
  // Heard by the row.
  await expect(page.locator('#kept-stores-text')).toHaveAttribute('title', /1 saved state/);
  await page.locator('#kept-stores-manage-btn').click();
  const saved = page.locator('#kept-stores-dialog .kept-saved-states');
  await expect(saved.locator('.kept-dataset-name')).toHaveText('Saved states');
  const row = saved.locator('[data-item-id^="saved:"]');
  await expect(row.locator('.select-item-name')).toHaveText('Current UI fixture');
  // What it is in the words of every list of saved states (`savedStateWords`), and when, as every
  // list of the app says it (`formatAgo`): saved a moment ago.
  await expect(row.locator('.select-item-meta')).toHaveText('"Probe" · 0 steps · saved just now');
  await expect(page.locator('#kept-stores-where dt:text-is("Holds") + dd')).toHaveText('files, saved states, My datasets, connection speeds');
  await row.locator('input').check();
  await page.locator('#kept-stores-remove-selected').click();
  await expect(page.locator('#kept-stores-status')).toHaveText('Removed 1 item.');
  await expect(saved).toHaveCount(0);
  expect(await page.evaluate(async () => (await import('/assets/js/app/history/autosave.js')).listSavedStates().then(list => list.length))).toBe(0);
  await expect(page.locator('#kept-stores-text')).not.toHaveAttribute('title', /saved state/);
  expect(errors).toEqual([]);
});
