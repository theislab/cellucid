/**
 * NCBI GEO: the supplementary files of a series (GSE) or a sample (GSM)
 * accession, read from `ftp.ncbi.nlm.nih.gov` (which allows cross-origin
 * range reads). Accepts `GSE123456`, `GSM123456`, either with `/<file>`, a
 * GEO accession page link, a supplementary file link, or
 * `geo:<accession>[/<file>]`.
 *
 * What a series offers is read from two listings fetched together: its
 * supplementary folder, and `filelist.txt`, which names every file of the
 * series' `_RAW.tar`. GEO keeps each of those files in its sample's own
 * folder (`/geo/samples/…/GSM…/suppl/`), so a sample's files are read there,
 * one by one, without the archive. The listings name no file's content, so
 * the files a dataset opens are probed, together, for their sizes and the
 * validators that version them (`remote-file.js`).
 *
 * A dataset is one file Cellucid opens (`.h5ad`, `.rds.gz`, `.loom`, …, or
 * a gzip-compressed copy of one, `.h5ad.gz`, read whole), or
 * a MatrixMarket sample: a matrix and the feature and barcode lists its
 * name pairs it with (`GSM…_matrix.mtx.gz`, `_features.tsv.gz` or
 * `_genes.tsv.gz`, `_barcodes.tsv.gz`; `data/matrix-market-files.js`),
 * named by its matrix. A link names one; a listing with several names the
 * choices. Grouping reads only the listings.
 *
 * @module data/sources/providers/geo
 */

import {
  DataSourceError,
  DataSourceErrorCode,
  fetchWhenNotBusy,
  hostFaultFailure,
} from '../../data-source.js';
import { fetchOnce, hostFaultOfStatus } from '../../../formats/io/byte-source.js';
import { describeRemoteFile, describeRemoteFileSet } from '../remote-file.js';
import { fileFormatOfName, titleOfName } from '../../input-formats.js';
import { cellTablesBySet, isMatrixMarketMatrix, matrixMarketFileSets } from '../../matrix-market-files.js';
import { formatCountOf } from '../../../utils/format-units.js';

const GEO_FTP = 'https://ftp.ncbi.nlm.nih.gov/geo/';
const ACCESSION = /^GS[EM][1-9][0-9]*$/;
const SAMPLE_PREFIX = /^(GSM[1-9][0-9]*)[_.-]/i;

function safeFileName(name) {
  return typeof name === 'string' &&
    name.length > 0 &&
    !/[/\\?#\u0000-\u001f\u007f]/.test(name) &&
    name !== '.' && name !== '..';
}

/** `GSE123456`, `GSM123456`, or either with `/<file>`; or null. */
function parseGeo(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  const plain = /^(gs[em][1-9][0-9]*)(?:\/(.+))?$/i.exec(text);
  if (plain !== null) {
    const accession = plain[1].toUpperCase();
    if (plain[2] === undefined) return accession;
    return safeFileName(plain[2]) ? `${accession}/${plain[2]}` : null;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'www.ncbi.nlm.nih.gov' || host === 'ncbi.nlm.nih.gov') {
    const acc = (url.searchParams.get('acc') ?? '').toUpperCase();
    if (!ACCESSION.test(acc)) return null;
    const file = url.searchParams.get('file');
    if (url.pathname.startsWith('/geo/download') && file !== null) {
      return safeFileName(file) ? `${acc}/${file}` : null;
    }
    return url.pathname.startsWith('/geo/') ? acc : null;
  }
  if (host === 'ftp.ncbi.nlm.nih.gov') {
    const match = /^\/geo\/(?:series|samples)\/GS[EM][0-9]*nnn\/(GS[EM][1-9][0-9]*)\/suppl\/([^/]*)$/i
      .exec(url.pathname);
    if (match === null) return null;
    const accession = match[1].toUpperCase();
    if (match[2] === '') return accession;
    const file = decodeURIComponent(match[2]);
    return safeFileName(file) ? `${accession}/${file}` : null;
  }
  return null;
}

/**
 * The supplementary folder of one series or sample (`GSE351300` →
 * `series/GSE351nnn/GSE351300/suppl/`, `GSM5008737` →
 * `samples/GSM5008nnn/GSM5008737/suppl/`).
 */
export function geoSupplementaryUrl(accession) {
  const kind = accession.slice(0, 3).toUpperCase();
  const digits = accession.slice(3);
  const stem = digits.length > 3 ? digits.slice(0, -3) : '';
  return `${GEO_FTP}${kind === 'GSM' ? 'samples' : 'series'}/${kind}${stem}nnn/${accession}/suppl/`;
}

/** File names listed in a GEO FTP-over-HTTPS directory page. */
export function parseGeoListing(html) {
  // A Set: a series lists thousands of files, each linked more than once.
  const names = new Set();
  for (const match of html.matchAll(/href="([^"?#/]+)"/g)) {
    let name;
    try {
      name = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    if (safeFileName(name)) names.add(name);
  }
  return [...names];
}

/**
 * The files of a series' `_RAW.tar`, from its `filelist.txt` (tab-separated
 * `Archive/File, Name, Time, Size, Type`): each a sample's file, with its
 * exact size. Lines of another shape are passed over.
 *
 * @param {string} text
 * @returns {Array<{name: string, size: number, sample: string}>}
 */
export function parseGeoFileList(text) {
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields[0] !== 'File' || fields.length < 4) continue;
    const name = fields[1];
    const size = Number(fields[3]);
    const sample = SAMPLE_PREFIX.exec(name)?.[1]?.toUpperCase();
    if (!safeFileName(name) || !Number.isSafeInteger(size) || size < 0 || sample === undefined) continue;
    files.push({ name, size, sample });
  }
  return files;
}

function listingFailure(accession, status) {
  if (hostFaultOfStatus(status) !== null) {
    return hostFaultFailure({ host: new URL(GEO_FTP).host, status, what: `the file list of ${accession}` }, { accession });
  }
  return new DataSourceError(
    status === 404
      ? `GEO ${accession} has no supplementary files. Check the accession on GEO.`
      : `GEO ${accession} could not be listed (HTTP ${status}). Try again later.`,
    status === 404 ? DataSourceErrorCode.NOT_FOUND : DataSourceErrorCode.NETWORK_ERROR,
    'link',
    { accession }
  );
}

/**
 * Whether NCBI's file service is failing, asked before a listing's answer is
 * taken to mean the accession lacks a file: while it fails, NCBI answers its
 * folder listings with no files, or only some (a series' `suppl/` folder
 * lists empty, or some of its files, while every file of `/geo/`,
 * `filelist.txt` and `geo/README.txt` included, answers
 * HTTP 500). The refusal that names the failing host, or null when NCBI
 * answers: a series' `filelist.txt` that answered a host-side status says
 * so at once; otherwise `geo/README.txt`, which NCBI keeps beside every
 * accession, is asked for one byte (only on this path: a listing that holds
 * what the link names costs nothing more).
 *
 * @param {string} accession
 * @param {number|null} archiveStatus - The status `filelist.txt` answered, or null
 * @param {string} missing - What the listing lacked, as "no <thing>"
 * @param {AbortSignal|null} signal
 * @returns {Promise<DataSourceError|null>}
 */
async function geoFailing(accession, archiveStatus, missing, signal) {
  const host = new URL(GEO_FTP).host;
  const folder = geoSupplementaryUrl(accession);
  if (hostFaultOfStatus(archiveStatus) !== null) {
    return hostFaultFailure({ host, status: archiveStatus, what: `the file list of ${accession} (its folder listed ${missing})` }, {
      accession,
      cause: new Error(`${folder}filelist.txt: HTTP ${archiveStatus}; ${folder} listed ${missing}.`),
    });
  }
  let status;
  try {
    // Asked once through the one transport: within NCBI's request budget,
    // and a host that does not answer ends it as stalled (null: not known).
    status = (await fetchOnce(`${GEO_FTP}README.txt`, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', credentials: 'omit' }, {
      fetchImpl: globalThis.fetch,
      signal,
      wantsBody: () => false,
    })).response.status;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
  return hostFaultOfStatus(status) !== null
    ? hostFaultFailure({ host, status, what: `its own geo/README.txt, asked because the folder of ${accession} listed ${missing}` }, {
      accession,
      cause: new Error(`${GEO_FTP}README.txt (bytes=0-0): HTTP ${status}; ${folder} listed ${missing}.`),
    })
    : null;
}

/**
 * Every file of an accession: the supplementary folder's and, for a series,
 * its `_RAW.tar` members in their samples' folders. Both listings are asked
 * for at once. Each file's `path` groups it by the folder it is read from.
 * `archiveStatus`: the status `filelist.txt` answered (null for a sample),
 * so a conclusion that a file is missing can ask whether NCBI is failing
 * (`geoFailing`).
 *
 * @returns {Promise<{files: Array<{name: string, url: string, path: string}>, archiveStatus: number|null}>}
 */
async function listAccession(accession, { signal, onStep }) {
  const folder = geoSupplementaryUrl(accession);
  onStep?.(`Listing the files of ${accession}`);
  const series = accession.startsWith('GSE');
  // NCBI lets a browser keep its answers for a day: the listings are asked
  // of it now, so a file added or replaced since is seen.
  const [listed, archived] = await Promise.all([
    fetchWhenNotBusy(folder, { signal, cache: 'no-cache' }),
    series ? fetchWhenNotBusy(`${folder}filelist.txt`, { signal, cache: 'no-cache' }) : Promise.resolve(null),
  ]);
  if (!listed.ok) throw listingFailure(accession, listed.status);
  const files = parseGeoListing(await listed.text())
    .filter(name => name !== 'filelist.txt')
    .map(name => ({ name, url: `${folder}${encodeURIComponent(name)}`, path: `${accession}/${name}` }));
  // A series without a `_RAW.tar` has no file list (404).
  if (archived !== null && archived.ok) {
    const known = new Set(files.map(file => file.name));
    for (const file of parseGeoFileList(await archived.text())) {
      if (known.has(file.name)) continue;
      known.add(file.name);
      files.push({
        name: file.name,
        url: `${geoSupplementaryUrl(file.sample)}${encodeURIComponent(file.name)}`,
        path: `${file.sample}/${file.name}`,
      });
    }
  }
  return { files, archiveStatus: archived?.status ?? null };
}

/**
 * What a listing offers: the single files Cellucid opens, and the
 * MatrixMarket samples (complete, and those that are not, with why).
 */
export function geoDatasets(files) {
  // A compressed copy (`.h5ad.gz`, as GEO ships many) opens too, read whole;
  // beside the file it is a copy of, it is that file.
  const paths = new Set(files.map(file => file.path));
  const singles = files.filter(file => {
    const format = fileFormatOfName(file.name);
    return format?.layout === 'file' && !(format.compression !== undefined && paths.has(file.path.slice(0, -3)));
  });
  const byPath = new Map(files.map(file => [file.path, file]));
  const { sets, problems } = matrixMarketFileSets(files.map(file => file.path));
  const tables = cellTablesBySet(byPath.keys(), sets);
  const samples = sets.map(set => ({
    matrix: byPath.get(set.matrix),
    features: byPath.get(set.features),
    cells: byPath.get(set.cells),
    tables: tables.get(set.matrix).map(path => byPath.get(path)),
    prefix: set.prefix,
    shared: set.shared,
  }));
  const incomplete = problems.map(item => ({ ...item, matrix: byPath.get(item.matrix) }));
  return { singles, samples, incomplete };
}

/** A matrix stored as text, one value a gene and cell (`GSE131907_…_raw_UMI_matrix.txt.gz`). */
const DENSE_TEXT_MATRIX = /(count|umi|matrix|expression|exprs|tpm|fpkm|rpkm|cpm|dge)[^/]*\.(txt|csv|tsv)(\.gz|\.bz2|\.xz)?$/i;
/** An archive other than the series' `_RAW.tar`, whose members GEO keeps in their samples' folders. */
const ARCHIVE = /\.(tar|tar\.gz|tgz|zip)$/i;

/**
 * What a listing holds that Cellucid does not read, and what to do with it:
 * a matrix stored as text (dense: every gene of every cell written out) and
 * an archive. Empty when it holds neither.
 */
function unreadNote(files) {
  const dense = files.filter(file => DENSE_TEXT_MATRIX.test(file.name) && !isMatrixMarketMatrix(file.name)).map(file => file.name);
  const archives = files.filter(file => ARCHIVE.test(file.name) && !/_RAW\.tar$/i.test(file.name)).map(file => file.name);
  let note = '';
  if (dense.length > 0) {
    note += ` ${dense.join(', ')} ${dense.length === 1 ? 'is a matrix' : 'are matrices'} stored as text, every gene of every cell written out, ` +
      'which Cellucid does not read (no part of it can be read without reading all of it). Download it and read it ' +
      'in Python with adata = sc.read_text(path) (sc.read_csv for a .csv; adata = adata.T when its rows are genes), ' +
      'or in R with counts <- as.matrix(data.table::fread(path), rownames = 1) and Seurat::CreateSeuratObject(counts); ' +
      'compute an embedding (sc.pp.normalize_total, sc.pp.log1p, sc.pp.pca, sc.pp.neighbors, sc.tl.umap; or Seurat\'s ' +
      'NormalizeData, FindVariableFeatures, ScaleData, RunPCA, RunUMAP), save it with cellucid.prepare(path, format="h5ad", data=adata) ' +
      'or cellucid::cellucid_prepare(path, data = obj), and open the file it writes.';
  }
  if (archives.length > 0) {
    note += ` ${archives.join(', ')} ${archives.length === 1 ? 'is an archive' : 'are archives'}, which Cellucid does not open: ` +
      'download and unpack it, then open the folder it holds with Open… › Folder… (a MatrixMarket folder or a Zarr store), or the file.';
  }
  return note;
}

/** The message a link to an incomplete MatrixMarket sample gets. */
function incompleteMessage(accession, item) {
  const name = item.matrix.name;
  if (item.missing.length > 0) {
    return `GEO ${accession} has ${name}, but no ${item.missing.join(' and no ')} for it, so its ` +
      `${item.missing.length === 2 ? 'rows and columns are' : /barcodes|cell_annotat/.test(item.missing[0]) ? 'cells are' : 'features are'} not named. ` +
      'The submitter may have uploaded them under another name or inside an archive: download the files from the GEO page, ' +
      'put the three beside each other, and open the folder with Open… › Folder….';
  }
  return `GEO ${accession} has ${item.ambiguous.map(path => path.slice(path.lastIndexOf('/') + 1)).join(' and ')} for ${name}, ` +
    'and which one belongs to it cannot be told from their names. Download the matrix, its barcodes and the one you mean ' +
    'into a folder of their own, and open it with Open… › Folder….';
}

function attributionOf(accession) {
  return {
    title: `NCBI GEO ${accession}`,
    url: `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${accession}`,
  };
}

/** Open one MatrixMarket sample: its matrix, lists and cell tables, read from where GEO keeps them. */
async function openSample(accession, sample, { signal, onStep }) {
  const members = [sample.matrix, sample.features, sample.cells, ...sample.tables];
  const title = `${accession} ${sample.prefix.replace(/[_.-]+$/, '') || titleOfName(sample.matrix.name)}`;
  const set = await describeRemoteFileSet({
    files: members.map(file => ({ url: file.url, name: file.name })),
    id: `geo:${accession}:${encodeURIComponent(sample.matrix.name)}`,
    rootName: title,
    title,
    format: { format: 'mtx', layout: 'folder' },
    attribution: attributionOf(accession),
    signal,
    onStep,
  });
  return { title: `${accession} / ${sample.matrix.name}`, files: set, attribution: set.attribution };
}

export default Object.freeze({
  id: 'geo',
  label: 'NCBI GEO',
  capabilities: Object.freeze({
    folders: false,
    private: 'none',
    public: true,
    versions: false,
    write: false,
  }),
  match(input) {
    return parseGeo(input);
  },
  /** A value carries nothing that grants access: it is shown as it is. */
  publicValue(value) {
    return value;
  },
  async open(value, { signal = null, onStep = null } = {}) {
    const parsed = parseGeo(value);
    if (parsed === null) {
      throw new DataSourceError(
        `"${value}" is not a GEO series or sample accession (GSE…, GSM…) or GEO link.`,
        DataSourceErrorCode.INVALID_FORMAT,
        'link',
        { input: value }
      );
    }
    const [accession, requested = null] = parsed.split(/\/(.*)/s);
    const folder = geoSupplementaryUrl(accession);
    // A file of the series' own folder opens without a listing; a sample's
    // file (it may be a `_RAW.tar` member) and a matrix (it needs its lists)
    // are found in the listings.
    const listed = requested === null || isMatrixMarketMatrix(requested) ||
      (accession.startsWith('GSE') && SAMPLE_PREFIX.test(requested));
    if (!listed) {
      // A matrix stored as text, or an archive: said with what to do, before
      // anything is read.
      const note = unreadNote([{ name: requested }]);
      if (note !== '') throw new DataSourceError(`GEO ${accession}:${note}`, DataSourceErrorCode.UNSUPPORTED, 'link', { accession, file: requested, explained: true });
      return openSingle(accession, { name: requested, url: `${folder}${encodeURIComponent(requested)}` }, { signal, onStep });
    }
    const { files, archiveStatus } = await listAccession(accession, { signal, onStep });
    const { singles, samples, incomplete } = geoDatasets(files);
    // A listing that lacks what is looked for may be NCBI failing: asked
    // before it is said to be missing.
    const unlessFailing = async (missing, refusal) => {
      throw (await geoFailing(accession, archiveStatus, missing, signal)) ?? refusal;
    };
    if (requested !== null) {
      const sample = samples.find(item => item.matrix.name === requested);
      if (sample !== undefined) return openSample(accession, sample, { signal, onStep });
      const broken = incomplete.find(item => item.matrix.name === requested);
      if (broken !== undefined) {
        await unlessFailing(
          `no ${broken.missing.length > 0 ? broken.missing.join(' or ') : 'single list'} for ${requested}`,
          new DataSourceError(incompleteMessage(accession, broken), DataSourceErrorCode.VALIDATION_ERROR, 'link', { accession, file: requested })
        );
      }
      const single = singles.find(file => file.name === requested);
      if (single !== undefined) return openSingle(accession, single, { signal, onStep });
      const listedFile = files.find(file => file.name === requested);
      if (listedFile === undefined) {
        await unlessFailing(`no ${requested}`, new DataSourceError(
          `GEO ${accession} has no file named ${requested}.`,
          DataSourceErrorCode.NOT_FOUND,
          'link',
          { accession, file: requested }
        ));
      }
      throw new DataSourceError(
        `${requested} is not a dataset Cellucid opens on its own` +
          (samples.length > 0 ? `. Open a MatrixMarket sample by its matrix: ${samples.map(item => `geo:${accession}/${item.matrix.name}`).join(', ')}.` : '.') +
          unreadNote([listedFile]),
        DataSourceErrorCode.UNSUPPORTED,
        'link',
        { accession, file: requested }
      );
    }
    const choices = [...singles.map(file => file.name), ...samples.map(item => item.matrix.name)];
    if (choices.length === 1) {
      return singles.length === 1
        ? openSingle(accession, singles[0], { signal, onStep })
        : openSample(accession, samples[0], { signal, onStep });
    }
    if (choices.length > 1) {
      throw new DataSourceError(
        `GEO ${accession} has ${formatCountOf(choices.length, 'dataset')} Cellucid opens` +
        (samples.length > 0 ? ` (${samples.length} MatrixMarket sample${samples.length === 1 ? ', opened by its matrix' : 's, opened by their matrix'})` : '') +
        `. Open one of them: ${choices.map(name => `geo:${accession}/${name}`).join(', ')}.` +
        (incomplete.length > 0
          ? ` ${incomplete.map(item => item.matrix.name).join(', ')} cannot open: ${incomplete.length === 1 ? 'its' : 'their'} feature or barcode files are missing or ambiguous.`
          : ''),
        DataSourceErrorCode.VALIDATION_ERROR,
        'link',
        { accession, files: choices }
      );
    }
    if (incomplete.length > 0) {
      await unlessFailing(
        `no ${incomplete[0].missing.length > 0 ? incomplete[0].missing.join(' or ') : 'single list'} for ${incomplete[0].matrix.name}`,
        new DataSourceError(incompleteMessage(accession, incomplete[0]), DataSourceErrorCode.UNSUPPORTED, 'link', { accession })
      );
    }
    const names = files.map(file => file.name);
    return unlessFailing(files.length === 0 ? 'no files' : 'no file Cellucid opens', new DataSourceError(
      `GEO ${accession} has no supplementary file Cellucid opens` +
        (names.length > 0 ? ` (it has: ${names.join(', ')}).` : '.') + unreadNote(files),
      DataSourceErrorCode.UNSUPPORTED,
      'link',
      { accession, files: names }
    ));
  },
});

/** Open one file of the accession, probed for its size and version. */
async function openSingle(accession, file, { signal, onStep }) {
  const described = await describeRemoteFile({
    url: file.url,
    id: `geo:${accession}:${encodeURIComponent(file.name)}`,
    name: file.name,
    title: `${accession} ${titleOfName(file.name)}`,
    attribution: attributionOf(accession),
    signal,
    onStep,
  });
  return { title: `${accession} / ${file.name}`, file: described, attribution: described.attribution };
}
