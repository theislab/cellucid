/**
 * "Save AnnData with this state…" from the History ⋯ menu
 * (`app/history/anndata-copy-save.js`): after a category renamed, a field a
 * notebook pushed, a highlight and a gene set, the menu item, reached by the
 * keyboard, writes a new Cellucid-ready AnnData `.zarr.zip`, read back here
 * with the app's own opener:
 *
 * - obs: the category renamed in its column, the field as a column, the
 *   highlight as a boolean column (by original position: the copy keeps the
 *   file's rows);
 * - var: the gene set as a boolean column; uns: the gene set by name, and
 *   `history_applied` naming the step shown, `package: 'web'`;
 * - where the browser gives the page a save dialog (Chromium), the file is
 *   the one it names (a private file here, the dialog stubbed with it);
 *   elsewhere a download;
 * - read by anndata and cellucid-python's `history_applied` too, when this
 *   machine has the Python environment (`tests/helpers/anndata-copy-python.mjs`).
 *
 * And a cancel while the copy's bytes are being written (its job's Cancel):
 * the file's writable is aborted, never closed, and nothing is said to be
 * saved. A MuData dataset is saved as a Cellucid-ready MuData, the
 * highlight on its global obs.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { expect, test } from './helpers/test.mjs';
import { expectDownloadNamed } from './helpers/downloads.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openPhoneSheet, openCollapsedPanels } from './helpers/panels.mjs';
import { takeSteps, waitForHistory } from './helpers/state-history.mjs';
import { chooseFiles } from './helpers/file-input.mjs';
import { SKIP as PYTHON_SKIP, python } from '../helpers/anndata-copy-python.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=history-anndata-copy`;
const CORPUS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openPhoneSheet(page);
  await waitForHistory(page);
  await page.locator('#state-section').evaluate(section => { section.open = true; });
}

/** A categorical obs field of the open dataset, its first category, and two genes. */
async function datasetFacts(page) {
  return page.evaluate(async () => {
    const state = window._cellucidState;
    await state.whenGenesListed();
    const index = state.obsData.fields.findIndex(field => field?.kind === 'category' && field._isUserDefined !== true);
    const field = await state.ensureFieldLoaded(index, { silent: true });
    const two = state.varData.fields.filter(gene => gene?._isUserDefined !== true).slice(0, 2);
    // The genes as the viewer names them, and their var rows (the matrix column each reads).
    const genes = two.map(gene => gene.key);
    const rows = two.map(gene => Number(/\/(\d+)$/.exec(gene.path)[1]));
    return { field: field.key, category: String(field.categories[0]), nObs: state.cellIdentity.nOriginal, genes, rows };
  });
}

/** Rename a category, push a field, highlight cells, save a gene set: the state the copy holds. */
async function takeTheSteps(page, facts) {
  const score = Array.from({ length: facts.nObs }, (_, cell) => cell / 4);
  const picked = Array.from({ length: Math.min(40, facts.nObs) }, (_, i) => 2 * i);
  await takeSteps(page, [
    ['category.rename', { field: { source: 'obs', key: facts.field }, category: facts.category, name: 'Renamed in Cellucid' }],
    ['field.push', { key: 'pushed_score', kind: 'continuous', categories: null, n_obs: facts.nObs, cells: null, values: score }, { origin: 'host', host: 'python' }],
    ['highlight.cells', { cells: picked, label: 'Picked', page: 'QC' }],
    ['gene-set.save', { name: 'Markers', description: 'Two genes', genes: facts.genes }],
  ]);
  return { score, picked };
}

/** Open the History ⋯ menu and choose the item with the keyboard. */
async function chooseSave(page) {
  const button = page.locator('#history-menu-btn');
  await expect(button).toBeEnabled();
  await button.focus();
  await page.keyboard.press('Enter');
  const item = page.getByRole('menuitem', { name: 'Save AnnData with this state…' });
  await expect(item).toBeVisible();
  await item.focus();
  await page.keyboard.press('Enter');
}

/**
 * Stub the save dialog: it hands back a file of this origin's private
 * storage (`real`) or a writable that records what is done to it and holds
 * its first write until `window.__releaseCopyWrite()` is called.
 */
async function stubSaveDialog(page, { real }) {
  await page.evaluate(async useReal => {
    window.__copyWritable = [];
    window.showSaveFilePicker = async ({ suggestedName }) => {
      window.__copyWritable.push(['dialog', suggestedName]);
      if (useReal) {
        const directory = await navigator.storage.getDirectory();
        return directory.getFileHandle(suggestedName, { create: true });
      }
      let release = null;
      const held = new Promise(resolve => { release = resolve; });
      window.__releaseCopyWrite = () => release();
      return {
        name: suggestedName,
        isSameEntry: async () => false,
        createWritable: async () => ({
          write: async part => { window.__copyWritable.push(['write', part.size]); await held; },
          close: async () => { window.__copyWritable.push(['close']); },
          abort: async () => { window.__copyWritable.push(['abort']); },
        }),
      };
    };
  }, real);
}

/** Open a copy's bytes with the app's opener and read what the spec checks. */
async function readCopy(page, base64, facts) {
  return page.evaluate(async ({ base64, facts }) => {
    const { openDatasetStore } = await import('/assets/js/data/anndata/open.js');
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const { root } = await openDatasetStore({ source: { file: new File([bytes], 'copy.zarr.zip') } }, { decodedChunkCacheBytes: 64 * 1024 * 1024 });
    await root.load();
    const obs = root.get('obs');
    const position = obs.get('cellucid_original_position');
    const order = position === null ? null : Array.from(await position.read(), Number);
    const byOriginal = values => {
      const out = new Array(values.length);
      for (let row = 0; row < values.length; row++) out[order === null ? row : order[row]] = values[row];
      return out;
    };
    const renamed = obs.get(facts.field);
    const highlight = byOriginal(Array.from(await obs.get('cellucid_highlight__QC__Picked').read(), Number));
    const score = byOriginal(Array.from(await obs.get('pushed_score').read()));
    const varSet = Array.from(await root.get('var/cellucid_gene_set__Markers').read(), Number);
    const cellucid = root.get('uns/cellucid');
    const geneSet = cellucid.get('gene_sets/Markers');
    return {
      layout: root.attrs['encoding-type'],
      columns: obs.attrs['column-order'],
      categories: Array.from(await renamed.get('categories').read()),
      highlight,
      score,
      varSet,
      geneSet: { genes: Array.from(await geneSet.get('genes').read()), origin: await geneSet.get('origin').read(), pulled: await geneSet.get('pulled_from').read() },
      applied: JSON.parse(await cellucid.get('history_applied').read()),
      id: await cellucid.get('id').read(),
    };
  }, { base64, facts });
}

test('saved from the History menu: labels, a field, a highlight and a gene set in a new .zarr.zip, read back', async ({ page, browserName }, testInfo) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  const facts = await datasetFacts(page);
  const { score, picked } = await takeTheSteps(page, facts);
  const head = await page.evaluate(() => window._cellucidHistories.current().active.headId);

  // Chromium gives the page a save dialog: stubbed with a private file. The others download.
  const dialog = browserName === 'chromium';
  if (dialog) await stubSaveDialog(page, { real: true });
  const downloaded = dialog ? null : page.waitForEvent('download');
  await chooseSave(page);
  const saved = page.locator('.notification', { hasText: /Saved .* with this state\.zarr\.zip/ });
  await expect(saved).toHaveCount(1);
  let base64;
  let name;
  if (dialog) {
    ({ base64, name } = await page.evaluate(async () => {
      const [, suggested] = window.__copyWritable[0];
      const directory = await navigator.storage.getDirectory();
      const file = await (await directory.getFileHandle(suggested)).getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await directory.removeEntry(suggested);
      return { base64: btoa(text), name: suggested };
    }));
  } else {
    const download = await downloaded;
    name = await expectDownloadNamed(download, / with this state\.zarr\.zip$/);
    base64 = (await readFile(await download.path())).toString('base64');
  }
  expect(name).toMatch(/ with this state\.zarr\.zip$/);
  const copy = await readCopy(page, base64, facts);
  expect(copy.layout).toBe('anndata');
  expect(copy.categories[0]).toBe('Renamed in Cellucid');
  expect(copy.columns.slice(-2)).toEqual(['pushed_score', 'cellucid_highlight__QC__Picked']);
  expect(copy.highlight).toEqual(Array.from({ length: facts.nObs }, (_, cell) => (picked.includes(cell) ? 1 : 0)));
  expect(copy.score).toEqual(score.map(value => Math.fround(value)));
  expect(copy.varSet.flatMap((value, row) => (value === 1 ? [row] : []))).toEqual([...facts.rows].sort((a, b) => a - b));
  expect(copy.geneSet).toEqual({ genes: facts.genes, origin: 'session', pulled: 'viewer' });
  expect(copy.applied).toHaveLength(1);
  expect(copy.applied[0]).toMatchObject({
    step: head, package: 'web', columns: ['pushed_score', 'cellucid_highlight__QC__Picked'], session: null,
    renamed: [{ kind: 'category', column: facts.field, from: facts.category, to: 'Renamed in Cellucid' }],
  });
  expect(copy.applied[0].session_sha256).toMatch(/^[0-9a-f]{64}$/);

  // The same bytes as anndata and cellucid-python read them.
  if (PYTHON_SKIP === false) {
    const file = testInfo.outputPath('copy.zarr.zip');
    await writeFile(file, Buffer.from(base64, 'base64'));
    const read = python(String.raw`
import json, sys
import anndata, zarr
from cellucid import history_applied
case = json.load(sys.stdin)
adata = anndata.read_zarr(zarr.storage.ZipStore(case["path"], mode="r"))
applied = history_applied(adata)
print(json.dumps({
  "n_obs": int(adata.n_obs),
  "categories": [str(c) for c in adata.obs[case["field"]].cat.categories],
  "picked": [int(i) for i, v in enumerate(adata.obs["cellucid_highlight__QC__Picked"].to_numpy()) if bool(v)],
  "score": [float(v) for v in adata.obs["pushed_score"].to_numpy()],
  "var_set": [i for i, v in enumerate(adata.var["cellucid_gene_set__Markers"].to_numpy()) if bool(v)],
  "gene_sets": {k: list(v["genes"]) for k, v in adata.uns["cellucid"]["gene_sets"].items()},
  "applied": [{"step": a["step"], "package": a["package"]} for a in applied],
}))
`, { path: file, field: facts.field });
    // anndata reads the file's rows: the copy keeps a priority-ordered file's order, so compare as sets.
    expect(read.n_obs).toBe(facts.nObs);
    expect(read.categories[0]).toBe('Renamed in Cellucid');
    expect(read.picked.length).toBe(picked.length);
    expect(read.score.slice().sort((a, b) => a - b)).toEqual(score.map(value => Math.fround(value)).sort((a, b) => a - b));
    expect(read.var_set).toEqual([...facts.rows].sort((a, b) => a - b));
    expect(read.gene_sets).toEqual({ Markers: facts.genes });
    expect(read.applied).toEqual([{ step: head, package: 'web' }]);
  }
  expect(errors).toEqual([]);
});

test('cancelled while its bytes are written: the file is aborted, never closed, and nothing is said to be saved', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  const facts = await datasetFacts(page);
  await takeTheSteps(page, facts);
  // A dialog on every engine here: its writable holds the first batch until released.
  await stubSaveDialog(page, { real: false });
  await chooseSave(page);
  await expect.poll(() => page.evaluate(() => window.__copyWritable.map(([kind]) => kind))).toEqual(['dialog', 'write']);
  const progress = page.locator('.notification', { hasText: 'Save AnnData with this state:' });
  await expect(progress).toHaveCount(1);
  await progress.locator('[data-role="cancel"]').click();
  await page.evaluate(() => window.__releaseCopyWrite());
  await expect.poll(() => page.evaluate(() => window.__copyWritable.map(([kind]) => kind))).toEqual(['dialog', 'write', 'abort']);
  await expect(progress).toHaveCount(0);
  await expect(page.locator('.notification', { hasText: /Saved .*\.zarr\.zip/ })).toHaveCount(0);
  // Saved afterwards as if nothing happened: the job and the menu are free again.
  expect(await page.evaluate(() => window._cellucidHistories.current().active.headId)).toBeTruthy();
  expect(errors).toEqual([]);
});

/** Unpack one fixture of the formats corpus (`tests/fixtures/<folder>/<writer>.zip`) for the page. */
async function unpacked(folder, writer, inside, made) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cellucid-copy-'));
  made.push(directory);
  const archive = readFileSync(path.join(CORPUS, folder, `${writer}.zip`));
  // A stored or deflated ZIP, read entry by entry from the central directory.
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = archive.readUInt32LE(end + 16);
  const count = archive.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    const method = archive.readUInt16LE(at + 10);
    const size = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const extra = archive.readUInt16LE(at + 30);
    const comment = archive.readUInt16LE(at + 32);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extra + comment;
    if (name.endsWith('/') || (name !== inside && !name.startsWith(`${inside}/`))) continue;
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const raw = archive.subarray(start, start + size);
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, method === 8 ? inflateRawSync(raw) : raw);
  }
  return path.join(directory, inside);
}

test('a MuData dataset is saved as a Cellucid-ready MuData, the highlight on its global obs', async ({ page, browserName }) => {
  const errors = observeProductErrors(page);
  const made = [];
  try {
    await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await openCollapsedPanels(page);
    await chooseFiles(page.locator('#user-data-file-input'), await unpacked('mudata', 'mudata-0.4.1', 'citeseq-subset.h5mu', made));
    await expect(page.locator('#dataset-name')).toHaveText(/citeseq/i);
    // The MuData's own history (the sample's is retired once it is shown).
    await page.waitForFunction(() => /citeseq/i.test(window._cellucidHistories?.current()?.snapshot?.().dataset?.name ?? '')
      && window._cellucidHistories.current().active != null);
    await page.locator('#state-section').evaluate(section => { section.open = true; });
    const nObs = await page.evaluate(() => window._cellucidState.cellIdentity.nOriginal);
    const picked = [0, 3, 5];
    await takeSteps(page, [['highlight.cells', { cells: picked, label: 'Picked', page: 'QC' }]]);
    const dialog = browserName === 'chromium';
    if (dialog) await stubSaveDialog(page, { real: true });
    const downloaded = dialog ? null : page.waitForEvent('download');
    await chooseSave(page);
    await expect(page.locator('.notification', { hasText: /Saved .*\.zarr\.zip/ })).toHaveCount(1);
    let base64;
    if (dialog) {
      base64 = await page.evaluate(async () => {
        const [, suggested] = window.__copyWritable[0];
        const directory = await navigator.storage.getDirectory();
        const bytes = new Uint8Array(await (await (await directory.getFileHandle(suggested)).getFile()).arrayBuffer());
        await directory.removeEntry(suggested);
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(text);
      });
    } else {
      base64 = (await readFile(await (await downloaded).path())).toString('base64');
    }
    const copy = await page.evaluate(async base64 => {
      const { openDatasetStore } = await import('/assets/js/data/anndata/open.js');
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const { root } = await openDatasetStore({ source: { file: new File([bytes], 'copy.zarr.zip') } }, { decodedChunkCacheBytes: 64 * 1024 * 1024 });
      await root.load();
      const stored = await import('/assets/js/data/anndata/write/copy-target.js');
      const target = await stored.readCopyTarget(root, ['cellucid_highlight__QC__Picked']);
      return {
        mudata: root.modalities?.length > 0,
        highlight: Array.from(target.columns.cellucid_highlight__QC__Picked.values),
        applied: JSON.parse(target.cellucid.history_applied).map(record => record.package),
      };
    }, base64);
    expect(copy.mudata).toBe(true);
    expect(copy.highlight).toEqual(Array.from({ length: nObs }, (_, cell) => (picked.includes(cell) ? 1 : 0)));
    expect(copy.applied).toEqual(['web']);
    expect(errors).toEqual([]);
  } finally {
    for (const directory of made) await rm(directory, { recursive: true, force: true });
  }
});
