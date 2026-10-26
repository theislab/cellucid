import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DataSourceError,
  DataSourceErrorCode,
  explainedFailure,
  isExplainedFailure,
} from '../assets/js/data/data-source.js';
import { serializeReaderError } from '../assets/js/data/anndata-reader-worker.js';
import { rebuildReaderError } from '../assets/js/data/anndata-reader-client.js';
import { describeDataSourceFailure, describeOpeningFailure } from '../assets/js/app/ui/modules/dataset-connections.js';
import { describeStartupFailure } from '../assets/js/app/startup-failure.js';
import { explainFormatError } from '../assets/js/data/anndata/open.js';
import { Hdf5UnsupportedError, openHdf5 } from '../assets/js/formats/hdf5/index.js';
import { filterName, unsupportedFilters } from '../assets/js/formats/hdf5/filters.js';
import { ZarrUnsupportedError, memoryStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { BYTE_SOURCE_FAILURES, ByteSourceError, bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';

test('a failure written for the person is shown as it is, never replaced by a generic cause', () => {
  const explained = explainedFailure(
    'Zenodo record 1 has 2 files Cellucid opens. Open one of them: zenodo:1/a.h5ad, zenodo:1/b.h5ad.',
    DataSourceErrorCode.VALIDATION_ERROR,
    'link'
  );
  assert.equal(isExplainedFailure(explained), true);
  assert.equal(
    describeDataSourceFailure('The linked data', 'could not be opened', explained),
    'The linked data could not be opened: Zenodo record 1 has 2 files Cellucid opens. ' +
      'Open one of them: zenodo:1/a.h5ad, zenodo:1/b.h5ad.'
  );
  // The first of several failures decides, as for the generic causes.
  assert.equal(isExplainedFailure(new AggregateError([explained, new Error('x')])), true);

  // A technical failure keeps the generic, classified sentence.
  const technical = new DataSourceError('Resource not found: https://h/x', DataSourceErrorCode.NOT_FOUND, 'link');
  assert.equal(isExplainedFailure(technical), false);
  assert.match(
    describeDataSourceFailure('The linked data', 'could not be opened', technical),
    /nothing is published at that address/
  );
});

/** The scale-offset dataset of the HDF5 corpus file of unsupported features. */
async function unsupportedHdf5Failure(path = 'scaleoffset') {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/hdf5/unsupported-features.h5', import.meta.url)));
  const root = await openHdf5(createByteReader(bytesByteSource(bytes, { name: 'unsupported-features.h5' })));
  try {
    return await root.get(path).read().then(() => null, error => error);
  } finally {
    root.close();
  }
}

/** The failure of reading a Zarr array compressed with `codec`. */
async function unsupportedZarrFailure(codec) {
  const encode = value => new TextEncoder().encode(JSON.stringify(value));
  const store = memoryStore({
    '.zgroup': encode({ zarr_format: 2 }),
    'X/.zarray': encode({
      zarr_format: 2, shape: [2], chunks: [2], dtype: '<f4', compressor: { id: codec },
      fill_value: 0, order: 'C', filters: null,
    }),
    'X/0': new Uint8Array(8),
  });
  return (async () => (await openZarr(store)).get('X').read())().then(() => null, error => error);
}

test('an AnnData refusal stays explained across the reader worker', async () => {
  const original = explainFormatError(await unsupportedHdf5Failure(), 'h5ad');
  const rebuilt = rebuildReaderError(structuredClone(serializeReaderError(original)));
  assert.equal(isExplainedFailure(rebuilt), true);
  assert.equal(rebuilt.message, original.message);
});

test('a compression the browser cannot decode is refused by name, before a read faults', async () => {
  // gzip and shuffle are HDF5's own, and LZF (h5py's) is read too: none is refused.
  assert.deepEqual(unsupportedFilters([{ id: 2 }, { id: 1 }]), []);
  assert.deepEqual(unsupportedFilters([]), []);
  assert.deepEqual(unsupportedFilters([{ id: 32000, name: 'lzf' }]), []);
  assert.equal(filterName({ id: 40000 }), 'filter 40000');
  assert.deepEqual(unsupportedFilters([{ id: 1 }, { id: 40000 }]), [{ id: 40000 }]);

  const hdf5Failure = await unsupportedHdf5Failure();
  assert.ok(hdf5Failure instanceof Hdf5UnsupportedError);
  const scaleOffset = explainFormatError(hdf5Failure, 'h5ad');
  assert.match(scaleOffset.message, /scaleoffset filter.*compression='gzip'/);
  assert.equal(scaleOffset.details.feature, 'filter:scaleoffset');
  assert.equal(isExplainedFailure(scaleOffset), true);

  const zarrFailure = await unsupportedZarrFailure('lzma');
  assert.ok(zarrFailure instanceof ZarrUnsupportedError);
  const lzma = explainFormatError(zarrFailure, 'zarr');
  assert.match(lzma.message, /'lzma'.*write_zarr/);
  assert.equal(isExplainedFailure(lzma), true);
  // Blosc with Zstandard, refused by the earlier reader, is now read.
  assert.equal(await unsupportedZarrFailure('zstd').then(error => error instanceof ZarrUnsupportedError), false);

  // Anything else is not dressed up as a format failure.
  const other = new Error('network down');
  assert.equal(explainFormatError(other, 'h5ad'), other);
});

test('a failed opening over the empty viewer says the reason itself, and whether trying again can help', () => {
  const sentence = 'Cellucid could not read the data this link points to.';
  // A refusal written for the person (a Cell Ranger matrix with no
  // embedding) is said as it is: trying again meets it again.
  const refusal = explainedFailure(
    'This 10x Cell Ranger .h5 file holds counts but no embedding. Open its outs/ folder, or compute a UMAP and save it with the counts.',
    DataSourceErrorCode.UNSUPPORTED,
    'link'
  );
  assert.deepEqual(describeOpeningFailure(sentence, refusal, { withoutLink: true }), {
    summary: refusal.message,
    settled: true,
  });
  assert.deepEqual(describeOpeningFailure(sentence, new AggregateError([refusal, new Error('x')]), { withoutLink: true }), {
    summary: refusal.message,
    settled: true,
  });
  // A classified failure: the sentence, its cause and what to do; an
  // address with nothing there is settled, a server's own problem is not.
  const absent = new DataSourceError('Resource not found: https://h/x.h5ad', DataSourceErrorCode.NOT_FOUND, 'link');
  const said = describeOpeningFailure(sentence, absent, { withoutLink: true });
  assert.equal(said.settled, true);
  assert.match(said.summary, /^Cellucid could not read the data this link points to: nothing is published at that address/);
  assert.doesNotMatch(said.summary, /https:\/\/h/);
  const busy = new DataSourceError('HTTP 503', DataSourceErrorCode.NETWORK_ERROR, 'link', { status: 503 });
  assert.equal(describeOpeningFailure(sentence, busy, { withoutLink: true }).settled, false);
  // Nothing classified: the sentence and the ways on.
  assert.deepEqual(describeOpeningFailure(sentence, new Error('boom'), { withoutLink: true }), {
    summary: `${sentence} Try again, or open Cellucid without it.`,
    settled: false,
  });
  assert.equal(
    describeOpeningFailure(sentence, new Error('boom'), { withoutLink: false }).summary,
    `${sentence} Try again, or open other data.`
  );
  // Written for the person but passing ("limited downloads for now").
  const limited = explainedFailure('Google has limited downloads of this file for now. Try again later.', DataSourceErrorCode.NETWORK_ERROR, 'link');
  assert.deepEqual(describeOpeningFailure(sentence, limited, { withoutLink: true }), { summary: limited.message, settled: false });
  // A read the provider holds back for now says the provider's sentence, and may pass.
  const held = new ByteSourceError(BYTE_SOURCE_FAILURES.UNREADABLE, 'pancreas.rds: Google is holding this file back. Try again in a few minutes.', { explained: true });
  assert.deepEqual(describeOpeningFailure(sentence, held, { withoutLink: true }), { summary: held.message, settled: false });
  assert.throws(() => describeOpeningFailure('no period', refusal, { withoutLink: true }), TypeError);

  // The startup failure screen says an explained reason too.
  const screen = describeStartupFailure(refusal, { webgl2Available: true, hasLaunchSettings: true });
  assert.equal(screen.kind, 'data');
  assert.equal(screen.sentence, refusal.message);
});
