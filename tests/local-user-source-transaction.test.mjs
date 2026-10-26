/**
 * One dataset chosen on the user's own computer (`LocalUserDirDataSource`):
 * a file (an `.h5ad`, a zipped Zarr store) or a Zarr store folder, what it
 * is decided from its content, read as an isolated candidate and adopted only when it opened
 * completely; a newer choice supersedes an older one.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { LocalUserDirDataSource } from '../assets/js/data/local-user-source.js';
import { defaultDatasetIdOf } from '../assets/js/data/input-formats.js';
import { zippedStoreEntries } from './helpers/zarr-corpus.mjs';

const FIXTURES = new URL('./fixtures/cellucid-ready/', import.meta.url);

function quiet(t) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  t.after(() => {
    console.log = log;
    console.warn = warn;
  });
}

function fixtureFile(name) {
  return new File([readFileSync(new URL(name, FIXTURES))], name);
}

/**
 * Every file of a fixture Zarr store folder, as a folder picker hands them
 * over: the store is kept once as `<name>.zip` and unpacked here.
 */
async function pickedFolder(name) {
  const entries = await zippedStoreEntries(fileURLToPath(new URL(`${name}.zip`, FIXTURES)));
  return [...entries].map(([key, bytes]) => {
    const file = new File([bytes], key.split('/').at(-1));
    Object.defineProperty(file, 'webkitRelativePath', { value: `${name}/${key}` });
    return file;
  });
}

function createFile(path, contents = '') {
  const normalizedPath = path.replace(/\\/g, '/');
  const name = normalizedPath.split('/').at(-1);
  const file = new Blob([contents]);
  Object.defineProperties(file, {
    name: {
      configurable: true,
      value: name
    },
    webkitRelativePath: {
      configurable: true,
      value: normalizedPath
    }
  });
  return file;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isExplicitSupersession(error) {
  return (
    error?.name === 'AbortError' ||
    /supersed|replac|newer selection|cancel|abort/i.test(error?.message || '')
  );
}

test('a chosen .h5ad is adopted under the id it states', async t => {
  quiet(t);
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());
  const initialAdoption = source.getAdoptionIdentity();
  const metadata = await source.loadFromFile(fixtureFile('ready.h5ad'));
  assert.equal(metadata.id, 'tiny-ready');
  assert.equal(metadata.name, 'Tiny ready dataset', 'a file the user chose names itself');
  assert.equal(source.datasetId, 'tiny-ready');
  assert.equal(source.getPath(), 'ready.h5ad');
  assert.equal(source.getBaseUrl('tiny-ready'), 'anndata://tiny-ready/');
  assert.equal(await source.isAvailable(), true);
  assert.deepEqual(await source.listDatasets(), [metadata]);
  assert.ok(source.getAdoptionIdentity() > initialAdoption);
  assert.throws(() => source.getBaseUrl('other'), /not found/);
  assert.equal(source.requiresManualReconnect(), true);
});

test('a chosen Zarr store folder is read in the browser, hidden metadata files included', async t => {
  quiet(t);
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());
  const files = await pickedFolder('ready.zarr');
  assert.ok(files.some(file => file.webkitRelativePath === 'ready.zarr/.zmetadata'));
  const metadata = await source.loadFromFolder(files);
  assert.equal(metadata.id, 'tiny-ready');
  assert.equal(metadata.source.name, 'Example lab');
  assert.equal(source.getBaseUrl('tiny-ready'), 'anndata://tiny-ready/');
  assert.equal(source.getPath(), 'ready.zarr');
});

test('a folder that is no Zarr store is refused, and the working dataset stays', async t => {
  quiet(t);
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());
  await source.loadFromFile(fixtureFile('ready.h5ad'));
  const adoption = source.getAdoptionIdentity();
  const notAStore = [new File(['x'], 'notes.txt')];
  Object.defineProperty(notAStore[0], 'webkitRelativePath', { value: 'folder/notes.txt' });
  await assert.rejects(
    source.loadFromFolder(notAStore),
    error => {
      assert.match(error.message, /not a folder Cellucid opens: it holds none of the files that make a \.zarr folder, a Cell Ranger outs\/ folder.*\. Choose that folder itself\./);
      assert.equal(error.details.explained, true);
      return true;
    }
  );
  await assert.rejects(source.loadFromFile(fixtureFile('unknown-key.h5ad')), /uns\['cellucid'\] may contain only: .*\(unexpected: colour\)/);
  assert.equal(source.getAdoptionIdentity(), adoption, 'a refused candidate changes nothing');
  assert.equal(source.datasetId, 'tiny-ready');
  assert.equal(source.getBaseUrl('tiny-ready'), 'anndata://tiny-ready/');
});

test('local selections expose a monotonic identity before asynchronous work', async t => {
  quiet(t);
  const source = new LocalUserDirDataSource();
  const initialIdentity = source.getSelectionIdentity();
  const loading = source.loadFromFile(fixtureFile('ready.h5ad'));
  const loadingIdentity = source.getSelectionIdentity();
  assert.ok(loadingIdentity > initialIdentity);
  source.clear();
  assert.ok(source.getSelectionIdentity() > loadingIdentity);
  await assert.rejects(loading, isExplicitSupersession);
  assert.equal(source.datasetId, null);
});

test('a chosen file that states no id is named after its file, and keeps its provenance', async t => {
  quiet(t);
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());
  const bytes = readFileSync(new URL('./browser/fixtures/data-mapping-full.zarr.zip', import.meta.url));
  const metadata = await source.loadFromFile(new File([bytes], 'portable.zarr.zip'));
  assert.equal(metadata.id, 'zarr_portable', 'a store that states no id is named after its file');
  assert.equal(metadata.name, 'portable');
  assert.equal(metadata.source.name, 'AnnData Zarr', 'named by the format its content shows');
  assert.equal(metadata.source.filename, 'portable.zarr.zip', 'the selected file is part of its provenance');
  assert.equal(source.getPath(), 'portable.zarr.zip');
  const inner = source.getAnnDataSource();
  assert.equal(inner.format, 'zarr');
  assert.equal(inner.describeStorage().layout, 'zip');
  assert.equal(inner.describeStorage().zarrVersion, 2);
  assert.equal((await inner.getMetadata(source.datasetId)).source.name, 'AnnData Zarr',
    'the adopted inner source and local UI source must expose one identity');
});

test('a chosen file is read as what its content is, whatever its name says', async t => {
  quiet(t);
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());
  // An .h5ad's bytes under a .zip name: its HDF5 signature decides.
  const bytes = readFileSync(new URL('./browser/fixtures/data-mapping-full.h5ad', import.meta.url));
  const metadata = await source.loadFromFile(new File([bytes], 'misnamed.zip'));
  assert.equal(metadata.id, 'h5ad_misnamed');
  assert.equal(source.getAnnDataSource().format, 'h5ad');
  assert.equal(source.getAnnDataSource().describeStorage().layout, 'file');
  await assert.rejects(source.loadFromFile(new File([bytes], 'notes.txt')), /Not a file Cellucid opens/);
});

for (const flow of [
  {
    name: 'H5AD',
    expectedDatasetId: 'h5ad_newer',
    prototype: AnnDataFileSource.prototype,
    method: 'loadFile',
    createSelection(name) {
      return [createFile(`${name}.h5ad`, name)];
    },
    invoke(source, selection) {
      return source.loadFromFile(selection[0]);
    },
    async installCandidate(candidate, selection, options) {
      const file = selection;
      candidate.filename = file.name;
      candidate.datasetId = options.datasetId ?? defaultDatasetIdOf('h5ad', file.name);
      candidate._metadata = {
        id: candidate.datasetId,
        name: file.name,
        stats: { n_cells: 2 }
      };
      return candidate._metadata;
    },
    getActiveCandidate(source) {
      return source.getAnnDataSource();
    }
  },
  {
    name: 'Zarr ZIP',
    expectedDatasetId: 'zarr_newer',
    prototype: AnnDataFileSource.prototype,
    method: 'loadFile',
    createSelection(name) {
      return [createFile(`${name}.zarr.zip`, name)];
    },
    invoke(source, selection) {
      return source.loadFromFile(selection[0]);
    },
    async installCandidate(candidate, selection, options) {
      const root = selection.name.replace(/\.zip$/i, '');
      candidate.filename = selection.name;
      candidate.datasetId = options.datasetId ?? defaultDatasetIdOf('zarr', selection.name);
      candidate._metadata = {
        id: candidate.datasetId,
        name: root,
        stats: { n_cells: 2 }
      };
      return candidate._metadata;
    },
    getActiveCandidate(source) {
      return source.getAnnDataSource();
    }
  }
]) {
  test(`overlapping ${flow.name} selections explicitly supersede the older load`, async t => {
    const source = new LocalUserDirDataSource();
    t.after(() => source.clear());

    const gates = new Map([
      ['older', deferred()],
      ['newer', deferred()]
    ]);
    const candidates = [];
    const originalLoad = flow.prototype[flow.method];
    flow.prototype[flow.method] = async function (selection, options) {
      candidates.push(this);
      const selectionName = flow.name === 'H5AD'
        ? selection.name.replace(/\.h5ad$/i, '')
        : selection.name.replace(/\.zarr\.zip$/i, '');
      await gates.get(selectionName).promise;
      return flow.installCandidate(this, selection, options);
    };
    t.after(() => {
      if (originalLoad === undefined) {
        delete flow.prototype[flow.method];
      } else {
        flow.prototype[flow.method] = originalLoad;
      }
    });

    const olderLoad = flow.invoke(
      source,
      flow.createSelection('older')
    );
    const newerLoad = flow.invoke(
      source,
      flow.createSelection('newer')
    );
    t.after(async () => {
      gates.get('older').resolve();
      gates.get('newer').resolve();
      await Promise.allSettled([olderLoad, newerLoad]);
    });
    assert.equal(candidates.length, 2, 'both selections must reach separate candidates');

    gates.get('newer').resolve();
    const newerMetadata = await newerLoad;
    gates.get('older').resolve();
    const olderOutcome = await Promise.allSettled([olderLoad]).then(
      ([outcome]) => outcome
    );

    assert.equal(
      newerMetadata.name,
      flow.name === 'H5AD' ? 'newer.h5ad' : 'newer.zarr'
    );
    assert.equal(
      source.datasetId,
      flow.expectedDatasetId
    );
    assert.equal(flow.getActiveCandidate(source), candidates[1]);
    assert.equal(
      olderOutcome.status,
      'rejected',
      'the older selection must not fulfill through the newer mutable candidate'
    );
    assert.equal(
      isExplicitSupersession(olderOutcome.reason),
      true,
      `older ${flow.name} load must report that a newer selection superseded it`
    );
    assert.equal(
      olderOutcome.reason?.code,
      'CELLUCID_DATASET_RELOAD_SUPERSEDED'
    );
  });
}

