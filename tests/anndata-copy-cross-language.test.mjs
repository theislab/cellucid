/**
 * What the web app's copy writes (`data/anndata/write/`) is read by Python
 * as the AnnData (or MuData) it copied: anndata and mudata read the
 * `.zarr.zip` (zarr's `ZipStore`) and every element equals what they read
 * from the source (obs and var frames, X and every layer and `raw.X` as
 * values, `obsm`, `obsp`, `varm`, `uns`); cellucid-python
 * (`CELLUCID_PYTHON_ROOT`, else the checkout beside this one) recognizes
 * the file as a Cellucid-ready AnnData Zarr archive, reads the same dataset
 * id and name, verifies a priority order the copy kept (`stored_order_of`)
 * and reads the history records a copy wrote (`history_applied`). Python's
 * `zipfile` reads the writer's ZIP64 archives: 70,000 entries, and an
 * archive of over 5 GiB (a sparse file on disk) whose entries lie past
 * 4 GiB.
 *
 * Runs where this machine has a Python with anndata, mudata and zarr
 * (`CELLUCID_PYTHON`, the workspace's environment,
 * `.environments/python/venv`, or `python3`) and the cellucid-python
 * checkout; skipped, saying why, where it has not, and a failure where
 * `CELLUCID_REQUIRE_VIEWERS=1` (the CI job with those packages) asks for it.
 */
import assert from 'node:assert/strict';
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createZipWriter } from '../assets/js/formats/zip/writer.js';
import { crc32 } from '../assets/js/formats/zip/crc32.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { copyToMemory, memorySink, openSource } from './helpers/anndata-copy.mjs';
import { PYTHON, SKIP, compareInPython, python } from './helpers/anndata-copy-python.mjs';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const PROVENANCE = JSON.parse(readFileSync(new URL('history-golden.expected.json', FIXTURES), 'utf8')).apply.provenance;

/** Every file of a corpus archive this test copies, written to `folder` (`[name, path]`). */
async function corpusFiles(folder, archiveName, keep) {
  const bytes = new Uint8Array(readFileSync(new URL(archiveName, FIXTURES)));
  const archive = await openZipArchive(createByteReader(bytesByteSource(bytes, { name: archiveName })));
  const files = [];
  for (const entry of archive.entries) {
    if (!keep(entry.path)) continue;
    // Named by archive and entry: two writers' corpora hold files of the same name.
    const file = path.join(folder, `${path.basename(archiveName, '.zip')}__${entry.path.replaceAll('/', '__')}`);
    writeFileSync(file, await entry.read());
    files.push(file);
  }
  return files;
}


test('anndata, mudata and cellucid-python read the copies as the AnnData they copy', { skip: SKIP }, async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'cellucid-copy-python-'));
  try {
    const cases = [];
    const add = async (name, sourcePath, kind, options = {}) => {
      const source = kind === 'folder' ? options.source : { file: new File([readFileSync(sourcePath)], path.basename(sourcePath)) };
      const opened = await openSource(source);
      const { bytes, result } = await copyToMemory(opened.root, { changes: options.changes ?? {} });
      const copy = path.join(folder, `${name.replaceAll('/', '__')}.copy.zarr.zip`);
      writeFileSync(copy, bytes);
      cases.push({
        name, source: sourcePath, copy, kind, mudata: result.layout === 'mudata',
        priority: options.priority ?? false, history: options.history ?? false, older: options.older ?? false,
        written: Object.keys(options.changes?.cellucid ?? {}),
        changed: Object.keys(options.changes?.cellucid ?? {}),
        added_obs: options.added ?? [],
      });
    };
    // The AnnData corpus of the newest and of the oldest anndata Zarr can hold, every file the reader reads.
    const index = JSON.parse(readFileSync(new URL('anndata/index.json', FIXTURES), 'utf8'));
    for (const writer of ['anndata-0.12.19', 'anndata-0.7.8']) {
      const reads = new Set(index.fixtures.filter(item => item.writer === writer && item.reader.expect === 'read').map(item => item.path.split('/').slice(1).join('/')));
      for (const file of await corpusFiles(folder, `anndata/${writer}.zip`, entry => reads.has(entry))) {
        const kind = file.endsWith('.h5ad') ? 'h5ad' : 'zarr-zip';
        await add(`${writer}/${path.basename(file)}`, file, kind, { older: writer === 'anndata-0.7.8' });
      }
    }
    // The layouts other tools leave behind (`emulated`), sparse matrices in uns among them.
    const emulated = new Set(index.fixtures.filter(item => item.writer === 'emulated' && item.reader.expect === 'read').map(item => item.path.split('/').slice(1).join('/')));
    for (const file of await corpusFiles(folder, 'anndata/emulated.zip', entry => emulated.has(entry))) {
      await add(`emulated/${path.basename(file)}`, file, 'h5ad', { older: true });
    }
    for (const file of await corpusFiles(folder, 'mudata/mudata-0.4.1.zip', entry => /\.(h5mu|zarr\.zip)$/.test(entry))) {
      await add(`mudata/${path.basename(file)}`, file, file.endsWith('.h5mu') ? 'h5mu' : 'mudata-zip');
    }
    // A priority-ordered file prepare() wrote, with the records an applied history writes.
    await add('priority/written', fileURLToPath(new URL('priority/written.zarr.zip', FIXTURES)), 'zarr-zip', {
      priority: true,
      history: true,
      // The apply record of the shared golden history (`history-golden.expected.json`), as the web app would write it.
      changes: { cellucid: { history_applied: JSON.stringify([{ ...PROVENANCE, applied_at: '2026-11-04T00:00:00.000Z', cellucid_version: '0.9.7', package: 'web' }]) } },
    });
    await add('cellucid-ready/ready', fileURLToPath(new URL('cellucid-ready/ready.h5ad', FIXTURES)), 'h5ad');
    // A column named in decomposed Unicode (NFD, as macOS writes it): anndata reads it under its name, never the fill.
    const decomposed = 'cafe\u0301_score';
    const cells = 300;
    await add('nfd/data-mapping-full', fileURLToPath(new URL('../tests/browser/fixtures/data-mapping-full.h5ad', import.meta.url)), 'h5ad', {
      changes: { obs: [{ name: decomposed, column: { kind: 'numbers', values: Float64Array.from({ length: cells }, (_, cell) => cell / 4) } }] },
      added: [decomposed],
    });
    assert.ok(cases.length > 100, `${cases.length} copies`);
    const checked = compareInPython(cases);
    for (const entry of checked) {
      const expected = cases.find(item => item.name === entry.name);
      assert.equal(entry.kind, expected.mudata ? 'mudata' : 'anndata', `${entry.name}: cellucid-python recognises the archive`);
      assert.equal(entry.layout, 'zip', `${entry.name}: as a Zarr archive`);
    }
    const priority = checked.find(entry => entry.name === 'priority/written');
    assert.deepEqual(priority.priority, { verified: true, notice: null }, 'cellucid-python verifies the priority order the copy kept');
    assert.deepEqual(priority.history.map(record => record.tracker), [PROVENANCE.tracker], 'cellucid-python reads the history records');
    const nfd = checked.find(entry => entry.name === 'nfd/data-mapping-full');
    assert.deepEqual(nfd.added[decomposed], Array.from({ length: cells }, (_, cell) => cell / 4), 'anndata reads the NFD-named column\'s values');
    const ready = checked.find(entry => entry.name === 'cellucid-ready/ready');
    assert.ok(ready.identity[0] !== null, 'the dataset id survives the copy');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('Python\'s zipfile reads the writer\'s ZIP64 archives: 70,000 entries, and entries past 4 GiB of a sparse file', { skip: PYTHON === undefined ? 'no Python on this machine' : false }, async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'cellucid-zip64-'));
  try {
    const many = memorySink();
    const zip = createZipWriter(many);
    for (let i = 0; i < 70_000; i++) await zip.add(`e/${i}`, Uint8Array.of(i & 0xff, (i >> 8) & 0xff));
    await zip.finish();
    writeFileSync(path.join(folder, 'many.zip'), many.bytes());
    // An archive of over 5 GiB on disk as a sparse file: its large entry's zeros are never written.
    const huge = 5 * 2 ** 30 + 7;
    const file = path.join(folder, 'huge.zip');
    const descriptor = openSync(file, 'w');
    let offset = 0;
    const sparse = createZipWriter({
      write(part) {
        if (part instanceof Blob) offset += part.size;
        else {
          writeSync(descriptor, part, 0, part.length, offset);
          offset += part.length;
        }
      },
    });
    await sparse.add('first.txt', new TextEncoder().encode('first'));
    let crc = 0;
    const zeros = new Uint8Array(64 * 1024 * 1024);
    for (let done = 0; done < huge; done += zeros.length) crc = crc32(zeros.subarray(0, Math.min(zeros.length, huge - done)), crc);
    await sparse.add('huge.bin', new (class extends Blob { get size() { return huge; } })([]), { crc });
    await sparse.add('after.txt', new TextEncoder().encode('past five gibibytes'));
    await sparse.finish();
    ftruncateSync(descriptor, offset);
    closeSync(descriptor);
    const read = python(String.raw`
import json, sys, zipfile
paths = json.load(sys.stdin)
many = zipfile.ZipFile(paths["many"])
assert many.testzip() is None
names = many.namelist()
huge = zipfile.ZipFile(paths["huge"])
info = huge.getinfo("huge.bin")
print(json.dumps({"entries": len(names), "last": list(many.read("e/69999")), "size": info.file_size,
  "offset": huge.getinfo("after.txt").header_offset, "first": huge.read("first.txt").decode(), "after": huge.read("after.txt").decode()}))
`, { many: path.join(folder, 'many.zip'), huge: file });
    assert.equal(read.entries, 70_000);
    assert.deepEqual(read.last, [69999 & 0xff, (69999 >> 8) & 0xff]);
    assert.equal(read.size, huge);
    assert.ok(read.offset > 2 ** 32, 'the entry after the large one lies past 4 GiB');
    assert.equal(read.first, 'first');
    assert.equal(read.after, 'past five gibibytes');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
