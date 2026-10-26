/**
 * The Zarr conformance corpus (`tests/fixtures/zarr`, written by
 * `scripts/generate-zarr-conformance-corpus.py`) keeps each store once, as a
 * `.zarr.zip` with the store at its top level, and so does every other Zarr
 * fixture. Tests that need the store as a picked folder or on a web host
 * unpack it here, in memory.
 */
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createByteReader } from '../../assets/js/formats/io/byte-reader.js';
import { blobByteSource } from '../../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../../assets/js/formats/zip/index.js';

export const ZARR_CORPUS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'zarr');

const unpacked = new Map();

/**
 * Every key of the Zarr store zipped at `zipPath` (`<name>.zarr.zip`) and its
 * bytes, in key order. Some archives hold the store under its folder name
 * (both layouts are tested as archives); keys are relative to the store
 * either way.
 *
 * @param {string} zipPath
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export function zippedStoreEntries(zipPath) {
  if (!unpacked.has(zipPath)) {
    unpacked.set(zipPath, (async () => {
      const name = path.basename(zipPath);
      const file = await openAsBlob(zipPath);
      const archive = await openZipArchive(createByteReader(blobByteSource(file, { name })));
      const sorted = [...archive.entries].sort((a, b) => (a.path < b.path ? -1 : 1));
      const folder = `${name.replace(/\.zip$/, '')}/`;
      const prefix = sorted.every(entry => entry.path.startsWith(folder)) ? folder : '';
      const entries = new Map();
      for (const entry of sorted) entries.set(entry.path.slice(prefix.length), (await entry.read()).slice());
      return entries;
    })());
  }
  return unpacked.get(zipPath);
}

/** Every key of `store` (e.g. `v2/cases.zarr`) and its bytes, in key order. */
export function corpusEntries(store) {
  return zippedStoreEntries(path.join(ZARR_CORPUS, `${store}.zip`));
}

/** `store` as a browser folder selection: paths carry the folder's name. */
export async function corpusFolder(store) {
  const name = path.basename(store);
  const files = new Map();
  for (const [key, bytes] of await corpusEntries(store)) {
    files.set(`${name}/${key}`, new File([bytes], key.split('/').at(-1)));
  }
  return files;
}
