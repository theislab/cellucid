/**
 * A copy of the open dataset as a Cellucid-ready AnnData `.zarr.zip`
 * (`assets/js/data/anndata/write/`), written in the browser by the reader
 * worker to a file of this origin's private storage through its writable
 * stream (the File System Access API's, where the engine gives a page one;
 * the bytes in memory otherwise), then:
 *
 * - opened with the app's own opener beside the source, every array of the
 *   source found again in the copy, value for value (bit for bit), a
 *   cell-major expression matrix as the same entries, gene-major;
 * - opened in the app itself: the same cells and genes, the column the copy
 *   added among the fields, its values where the cells are.
 *
 * Fixtures: `data-mapping-full` (300 cells; `raw.X` of 8 genes) as `.h5ad`
 * and as `.zarr.zip`.
 */
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { chooseFiles } from './helpers/file-input.mjs';
import { SKIP as PYTHON_SKIP, compareInPython } from '../helpers/anndata-copy-python.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const START_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=data-mapping-groups-ci`;
const CELLS = 300;

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/**
 * In the page: write the open dataset's copy (with one obs column, by
 * original position) to a private-storage file, compare it with the
 * source (`sourceBase64`) through the app's opener, and hand its bytes back.
 */
async function writeAndCompare(page, name, sourceBase64) {
  return page.evaluate(async ({ name, sourceBase64, cells }) => {
    const { getDataSourceManager } = await import('/assets/js/data/data-source-manager.js');
    const { openDatasetStore } = await import('/assets/js/data/anndata/open.js');
    const { currentLayoutView, isOlderAnnDataLayout } = await import('/assets/js/data/anndata/older-layouts.js');
    const manager = getDataSourceManager();
    const adapter = manager.getSource(manager.getCurrentSourceType()).getAnnDataSource(manager.getCurrentDatasetId()).getAdapter();

    // The copy, through the stream a saved file is written with.
    // A private file's stream where the engine gives a page one (WebKit's automation refuses private storage).
    let directory = null;
    let handle = null;
    let writable = null;
    try {
      directory = await navigator.storage.getDirectory();
      handle = await directory.getFileHandle(`copy-of-${name}`, { create: true });
      writable = typeof handle.createWritable === 'function' ? await handle.createWritable() : null;
    } catch {
      writable = null;
    }
    const held = [];
    const sink = { write: bytes => (writable === null ? held.push(bytes.slice()) : writable.write(bytes)) };
    const picked = Uint8Array.from({ length: cells }, (_, position) => (position % 3 === 0 ? 1 : 0));
    // How far it is: its read activity's (the one channel reads are shown by), of the job that asked.
    const { getReadActivityLog } = await import('/assets/js/data/read-activity-log.js');
    const reports = [];
    const stop = getReadActivityLog().subscribe(report => {
      if (report.kind === 'cells' && report.label === 'a copy of the dataset') reports.push(report);
    });
    const started = performance.now();
    const result = await adapter.writeAnnDataCopy({ obs: [{ name: 'picked_by_copy', column: { kind: 'booleans', values: picked } }] }, {
      sink,
      owner: 'job-save-copy',
    });
    const ms = performance.now() - started;
    let copyFile;
    if (writable !== null) {
      await writable.close();
      copyFile = await handle.getFile();
    } else {
      copyFile = new File(held, `copy-of-${name}`);
    }

    // Both through the app's opener, the source presented as the reader presents it.
    const sourceBytes = Uint8Array.from(atob(sourceBase64), character => character.charCodeAt(0));
    const source = await openDatasetStore({ source: { file: new File([sourceBytes], name) } }, { decodedChunkCacheBytes: 64 * 1024 * 1024 });
    const copy = await openDatasetStore({ source: { file: new File([copyFile], 'copy.zarr.zip') } }, { decodedChunkCacheBytes: 64 * 1024 * 1024 });
    const from = isOlderAnnDataLayout(source.root) ? await currentLayoutView(source.root) : source.root;
    await from.load();
    await copy.root.load();
    const bits = values => Array.from(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    const entries = async group => {
      const shape = group.attrs.shape.map(Number);
      const csr = group.attrs['encoding-type'] === 'csr_matrix';
      const [data, indices, indptr] = await Promise.all(['data', 'indices', 'indptr'].map(key => group.get(key).read()));
      const out = [];
      for (let line = 0; line < (csr ? shape[0] : shape[1]); line++) {
        for (let k = Number(indptr[line]); k < Number(indptr[line + 1]); k++) {
          out.push(csr ? [line, Number(indices[k]), data[k]] : [Number(indices[k]), line, data[k]]);
        }
      }
      return JSON.stringify(out.sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    };
    const differences = [];
    const compared = { arrays: 0, transposed: [] };
    const walk = async (a, b, at) => {
      for (const key of a.keys()) {
        const where = at === '' ? key : `${at}/${key}`;
        const node = a.get(key);
        const other = b.get(key);
        if (other === null) {
          differences.push(`${where} is missing`);
          continue;
        }
        if (node.kind === 'array') {
          const [x, y] = await Promise.all([node.read(), other.read()]);
          const same = ArrayBuffer.isView(x)
            ? x.constructor === y.constructor && JSON.stringify(bits(x)) === JSON.stringify(bits(y))
            : JSON.stringify(x) === JSON.stringify(y);
          if (!same || JSON.stringify(node.shape) !== JSON.stringify(other.shape)) differences.push(`${where} differs`);
          compared.arrays++;
          continue;
        }
        if (node.attrs['encoding-type'] === 'csr_matrix' && other.attrs['encoding-type'] === 'csc_matrix') {
          if (await entries(node) !== await entries(other)) differences.push(`${where} entries differ`);
          compared.transposed.push(where);
          continue;
        }
        await walk(node, other, where);
      }
    };
    await walk(from, copy.root, '');
    const added = await copy.root.get('obs/picked_by_copy').read();
    const positions = copy.root.get('obs/cellucid_original_position');
    const order = positions === null ? null : await positions.read();
    const placed = Array.from(added).every((value, row) => value === picked[order === null ? row : Number(order[row])]);
    const copyBytes = new Uint8Array(await copyFile.arrayBuffer());
    let text = '';
    for (let i = 0; i < copyBytes.length; i += 0x8000) text += String.fromCharCode(...copyBytes.subarray(i, i + 0x8000));
    if (writable !== null) await directory.removeEntry(`copy-of-${name}`);
    return {
      result,
      datasetId: adapter.getMetadata()?.id ?? null,
      ms,
      streamed: writable !== null,
      size: copyFile.size,
      progressEnds: (() => {
        getReadActivityLog().flush();
        stop();
        const last = reports.at(-1);
        return last?.status === 'done' && last.owner === 'job-save-copy' && last.progress?.done === last.progress?.total && last.progress.total > 0;
      })(),
      differences,
      compared,
      placed,
      copyBase64: btoa(text),
    };
  }, { name, sourceBase64, cells: CELLS });
}

for (const name of ['data-mapping-full.h5ad', 'data-mapping-full.zarr.zip']) {
  test(`${name}: a copy written in the browser holds every array of the source, and opens in Cellucid`, async ({ page, browserName }, testInfo) => {
    const errors = collectBrowserErrors(page);
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
    await openCollapsedPanels(page);
    const fixture = path.join(FIXTURES, name);
    await chooseFiles(page.locator('#user-data-file-input'), fixture);
    await expect(page.locator('#dataset-name')).toHaveText('data-mapping-full');
    const genes = await page.evaluate(async () => {
      const state = window._cellucidState;
      await state.whenGenesListed();
      return state.getVarAxisGeneCount();
    });

    const outcome = await writeAndCompare(page, name, readFileSync(fixture).toString('base64'));
    // Chromium and Firefox give a page a private file's writable stream (WebKit, here, none).
    if (browserName !== 'webkit') expect(outcome.streamed, 'written through a file\'s writable stream').toBe(true);
    expect(outcome.size).toBe(outcome.result.bytes);
    expect(outcome.result.nObs).toBe(CELLS);
    expect(outcome.result.layout).toBe('anndata');
    expect(outcome.progressEnds).toBe(true);
    expect(outcome.differences).toEqual([]);
    expect(outcome.compared.arrays).toBeGreaterThan(10);
    expect(outcome.placed, 'the added column\'s values sit at their cells\' rows').toBe(true);
    testInfo.annotations.push({ type: 'copy', description: `${outcome.size} bytes in ${outcome.ms.toFixed(0)} ms; ${outcome.compared.arrays} arrays compared, transposed: ${outcome.compared.transposed.join(', ') || 'none'}` });

    // The copy opens in Cellucid: the same cells and genes, and the added column is a field.
    const saved = testInfo.outputPath(`copy-of-${name.replace(/\.(h5ad|zarr\.zip)$/, '')}.zarr.zip`);
    writeFileSync(saved, Buffer.from(outcome.copyBase64, 'base64'));
    // The bytes this browser wrote, read by anndata and cellucid-python as the AnnData they copy.
    if (PYTHON_SKIP === false) {
      const [checked] = compareInPython([{
        name, source: fixture, copy: saved, kind: name.endsWith('.h5ad') ? 'h5ad' : 'zarr-zip', mudata: false,
        // The dataset's names the copy wrote where the file had none, and the column it added.
        written: ['schema', 'id', 'name'], added_obs: ['picked_by_copy'],
      }]);
      expect(checked.kind).toBe('anndata');
      expect(checked.added.picked_by_copy).toEqual(Array.from({ length: CELLS }, (_, cell) => cell % 3 === 0));
      expect(checked.identity[0]).toBe(outcome.datasetId);
    }
    await chooseFiles(page.locator('#user-data-file-input'), saved);
    // Opened once the added column is among the fields (the source has the same cells and genes).
    await expect.poll(() => page.evaluate(() => (window._cellucidState.getFields() ?? []).some(field => field.key === 'picked_by_copy'))).toBe(true);
    expect(await page.evaluate(() => window._cellucidState.pointCount)).toBe(CELLS);
    const opened = await page.evaluate(async () => {
      const state = window._cellucidState;
      await state.whenGenesListed();
      return { genes: state.getVarAxisGeneCount(), fields: (state.getFields() ?? []).map(field => field.key) };
    });
    expect(opened.genes).toBe(genes);
    expect(opened.fields).toContain('picked_by_copy');
    expect(errors).toEqual([]);
  });
}
