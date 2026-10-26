/**
 * Write the store each corpus file transcodes to (`data/anndata/transcode/`)
 * as a Zarr folder, so anndata itself can read it (`verify_with_python.py`):
 * a transcoded store is a real AnnData (or MuData) Zarr store.
 *
 * Usage: node scripts/rds-corpus/materialize.mjs <corpus.zip> <out-dir>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TRANSCODERS } from '../../assets/js/data/anndata/transcode/index.js';
import { createByteReader } from '../../assets/js/formats/io/byte-reader.js';
import { blobByteSource, bytesByteSource } from '../../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../../assets/js/formats/zip/index.js';
import { fileFormatOfName, folderFormatOfPaths } from '../../assets/js/data/input-formats.js';

const [zipPath, out] = process.argv.slice(2);
const archive = await openZipArchive(createByteReader(bytesByteSource(new Uint8Array(await readFile(zipPath)), { name: 'corpus.zip' })));
const read = async name => (await archive.entry(name).read()).slice();
const expectations = archive.entries.map(entry => entry.path).filter(name => name.endsWith('.expected.json'));
const byteReaderOf = file => createByteReader(blobByteSource(file));
for (const expectation of expectations) {
  const expected = JSON.parse(new TextDecoder().decode(await read(expectation)));
  if (expected.outcome !== 'open' || expected.values === false) continue;
  const name = expectation.slice(0, -'.expected.json'.length);
  const inside = archive.entries.map(entry => entry.path).filter(entry => entry.startsWith(`${name}/`));
  let source;
  let format;
  if (inside.length > 0) {
    const files = new Map();
    for (const entry of inside) files.set(entry.slice(name.length + 1), new File([await read(entry)], path.basename(entry)));
    source = { files, rootName: path.basename(name) };
    format = folderFormatOfPaths(files.keys()).format;
  } else {
    source = { file: new File([await read(name)], path.basename(name)) };
    format = fileFormatOfName(name).format;
  }
  const { store } = await TRANSCODERS[format].transcode(source, { byteReaderOf, memory: true });
  const target = path.join(out, `${name.replace(/\//g, '__')}.zarr`);
  for (const key of store.list()) {
    const bytes = await store.get(key);
    await mkdir(path.dirname(path.join(target, key)), { recursive: true });
    await writeFile(path.join(target, key), bytes);
  }
  await writeFile(`${target}.expected.json`, JSON.stringify(expected));
  console.log(target);
}
