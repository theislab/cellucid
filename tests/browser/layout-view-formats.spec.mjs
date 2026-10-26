/**
 * Loom, 10x Cell Ranger and MuData opened in the browser, end to end: picked
 * with File…, dropped as a folder, read in place by the reader worker
 * through their layout views (`data/anndata/views/`).
 *
 * - a `.loom` and an `.h5mu` open like an `.h5ad`, the Dataset box naming
 *   their format;
 * - a multimodal file shows one Modality select in Data mapping; choosing
 *   another modality reads its features (a protein, NaN on the cells it was
 *   not measured on), and a session saved on a modality restores it;
 * - a 10x `.h5` alone has no embedding and is refused with what to do; the
 *   Cell Ranger `outs/` folder it came from opens with Cell Ranger's own
 *   projections.
 *
 * Fixtures are the layout-view corpus (`tests/fixtures/{loom,tenx,mudata}/`,
 * `scripts/formats-corpus/`), unpacked for the page.
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { createDrag, dragAndDrop, folderPayload } from './helpers/dataset-drop.mjs';
import { fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const START_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=layout-view-formats`;

/** Every entry of one corpus archive (stored or deflated), by its path. */
function unzip(file) {
  const bytes = readFileSync(file);
  const entries = new Map();
  let end = bytes.length - 22;
  while (bytes.readUInt32LE(end) !== 0x06054b50) end--;
  let at = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    const method = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30);
    const comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    entries.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

/** One corpus file or folder written to a temporary directory: its path there. */
async function unpacked(folder, writer, inside) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cellucid-formats-'));
  for (const [name, data] of unzip(path.join(FIXTURES, folder, `${writer}.zip`))) {
    if (name !== inside && !name.startsWith(`${inside}/`)) continue;
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  return path.join(directory, inside);
}

function collectBrowserErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openStart(page) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await openCollapsedPanels(page);
}

async function expectOpened(page, cells) {
  await expect(page.locator('#dataset-cells')).toHaveText(String(cells));
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
  await expect(page.locator('#dataset-info')).not.toHaveAttribute('data-state', 'loading');
}

async function openGenesSection(page) {
  const header = page.locator('#data-mapping-disclosure > .disclosure-header-row > .disclosure-header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  const genes = page.locator('[data-mapping-section="genes"] .disclosure-header');
  if ((await genes.getAttribute('aria-expanded')) !== 'true') await genes.click();
}

test('a Loom file opens like an .h5ad and has no Modality select', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openStart(page);
  await chooseFiles(page.locator('#user-data-file-input'), await unpacked('loom', 'loompy-3.0.8', 'basic.loom'));
  await expectOpened(page, 48);
  await expect(page.locator('#dataset-name')).toHaveText('basic');
  expect(await page.evaluate(() => window._cellucidState.getDataMapping().modality)).toBeUndefined();
  await openGenesSection(page);
  await expect(page.locator('#data-mapping-modality')).toBeHidden();
  await expect(page.locator('#data-mapping-expression')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a CITE-seq .h5mu shows one Modality select; choosing the proteins reads them', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openStart(page);
  await chooseFiles(page.locator('#user-data-file-input'), await unpacked('mudata', 'mudata-0.4.1', 'citeseq-subset.h5mu'));
  await expectOpened(page, 44);
  expect(await page.evaluate(() => window._cellucidState.getDataMapping().modality)).toBe('rna');
  await openGenesSection(page);
  const modality = page.locator('#data-mapping-modality');
  await expect(modality).toBeVisible();
  await expect(modality.locator('option')).toHaveText(['prot · 5 features · 36 of 44 cells', 'rna · 28 features']);
  await modality.selectOption('prot');
  await page.locator('#data-mapping-apply').click();
  await expect.poll(() => page.evaluate(() => window._cellucidState.getDataMapping().modality)).toBe('prot');
  await expect.poll(() => page.evaluate(() => window._cellucidState.getVarAxisGeneCount())).toBe(5);
  expect(errors).toEqual([]);
});

test('a 10x .h5 alone is refused with what to do; its outs/ folder opens with Cell Ranger\'s projections', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openStart(page);
  await chooseFiles(page.locator('#user-data-file-input'), await unpacked('tenx', 'tenx', 'v3-citeseq.h5'));
  await expect(
    page.locator('#notification-center .notification[data-type="error"]').filter({
      hasText: /has no cell embedding.*open the whole outs\/ folder \(Open… › Folder…\)/,
    }),
  ).toHaveCount(1);
  // Picked on this computer: nothing to download.
  await expect(page.locator('#notification-center .notification[data-type="error"]').filter({ hasText: /download/ })).toHaveCount(0);
  // Nothing changed.
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');

  const outs = await unpacked('tenx', 'tenx', 'v3-citeseq-outs');
  const drag = await createDrag(page, { folder: { name: path.basename(outs), files: await folderPayload(outs) } });
  await dragAndDrop(page, drag);
  await expectOpened(page, 40);
  expect(await page.evaluate(() => window._cellucidState.getDataMapping().modality)).toBe('Gene Expression');
  await openGenesSection(page);
  await expect(page.locator('#data-mapping-modality option')).toHaveText(['Gene Expression · 30 features', 'Antibody Capture · 6 features']);
  expect(errors).toEqual([]);
});

test('a session saved on another modality restores it', async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await openStart(page);
  await chooseFiles(page.locator('#user-data-file-input'), await unpacked('mudata', 'mudata-0.4.1', 'citeseq.h5mu'));
  await expectOpened(page, 44);
  await openGenesSection(page);
  const modality = page.locator('#data-mapping-modality');
  const applyModality = async name => {
    await modality.selectOption(name);
    await page.locator('#data-mapping-apply').click();
    await expect.poll(() => page.evaluate(() => window._cellucidState.getDataMapping().modality)).toBe(name);
  };
  await applyModality('prot');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const sessionPath = testInfo.outputPath('modality.cellucid-session');
  await (await downloadPromise).saveAs(sessionPath);

  await applyModality('rna');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  await (await chooserPromise).setFiles(sessionPath);
  await expect.poll(() => page.evaluate(() => window._cellucidState.getDataMapping().modality)).toBe('prot');
  await expect.poll(() => page.evaluate(() => window._cellucidState.getVarAxisGeneCount())).toBe(5);
  expect(errors).toEqual([]);
});

test('a 10x .h5 linked at startup fails over the empty viewer, saying what to do', async ({ page }) => {
  const url = `${SAMPLE_ORIGIN}/formats/filtered_feature_bc_matrix.h5`;
  const bytes = await readFile(await unpacked('tenx', 'tenx', 'v3-gex.h5'));
  await page.route(url, route => fulfillFile(route, bytes));
  await page.goto(`/?data=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });
  const failed = page.locator('.opening-overlay[data-state="failed"]');
  await expect(failed).toBeVisible();
  await expect(failed.locator('.opening-title')).toHaveText('The data could not be opened');
  // The dialog says the reason itself, as the notification does, not a
  // generic "could not read"; trying again cannot change a refusal, so the
  // way on it leads with is opening Cellucid without the link.
  // From a link, which opens one file and no folder: the outs/ folder is
  // downloaded and opened from this computer.
  await expect(failed.locator('.opening-step')).toContainText(
    /has no cell embedding.*a link to one file cannot bring along: download the whole outs\/ folder and open it from this computer/
  );
  await expect(failed.locator('.opening-step')).not.toContainText('could not read the data this link points to');
  await expect(page.locator('.notification[data-type="error"]').filter({ hasText: /has no cell embedding/ })).toHaveCount(1);
  await expect(failed.locator('.welcome-details-text')).toContainText(/has no cell embedding.*download the whole outs\/ folder/);
  const actions = failed.locator('.opening-actions button');
  await expect(actions).toHaveText(['Open without this link', 'Try again']);
  await expect(actions.first()).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
});
