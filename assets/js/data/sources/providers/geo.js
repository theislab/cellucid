/**
 * NCBI GEO series: the `.h5ad` supplementary files of a GSE accession, read
 * in place from `ftp.ncbi.nlm.nih.gov` (which allows cross-origin range
 * reads). Accepts `GSE123456`, `GSE123456/<file>.h5ad`, a GEO accession page
 * link, a supplementary file link, or `geo:<accession>[/<file>]`.
 *
 * A series with several `.h5ad` files opens one at a time: the link names
 * the file, and a link without one lists the choices.
 *
 * @module data/sources/providers/geo
 */

import { DataSourceError, DataSourceErrorCode, fetchWhenNotBusy } from '../../data-source.js';
import { describeRemoteFile } from '../remote-file.js';
import { compressedFormatOfName, fileFormatOfName, namesOfLayout, titleOfName } from '../../input-formats.js';

const GEO_FTP = 'https://ftp.ncbi.nlm.nih.gov/geo/series/';
const ACCESSION = /^GSE[1-9][0-9]*$/;

function safeFileName(name) {
  return typeof name === 'string' &&
    name.length > 0 &&
    !/[/\\?#\u0000-\u001f\u007f]/.test(name) &&
    name !== '.' && name !== '..';
}

/** `GSE123456` or `GSE123456/<file>`, or null. */
function parseGeo(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  const plain = /^(gse[1-9][0-9]*)(?:\/(.+))?$/i.exec(text);
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
    const match = /^\/geo\/series\/GSE[0-9]*nnn\/(GSE[1-9][0-9]*)\/suppl\/([^/]*)$/i
      .exec(url.pathname);
    if (match === null) return null;
    const accession = match[1].toUpperCase();
    if (match[2] === '') return accession;
    const file = decodeURIComponent(match[2]);
    return safeFileName(file) ? `${accession}/${file}` : null;
  }
  return null;
}

/** The supplementary folder of one series (`GSE351300` → `GSE351nnn`). */
export function geoSupplementaryUrl(accession) {
  const digits = accession.slice(3);
  const stem = digits.length > 3 ? digits.slice(0, -3) : '';
  return `${GEO_FTP}GSE${stem}nnn/${accession}/suppl/`;
}

/** File names listed in a GEO FTP-over-HTTPS directory page. */
export function parseGeoListing(html) {
  const names = [];
  for (const match of html.matchAll(/href="([^"?#/]+)"/g)) {
    let name;
    try {
      name = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    if (safeFileName(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

export default Object.freeze({
  id: 'geo',
  label: 'NCBI GEO',
  capabilities: Object.freeze({
    folders: false,
    private: 'none',
    versions: false,
    write: false,
  }),
  match(input) {
    return parseGeo(input);
  },
  async open(value, { signal = null, onStep = null } = {}) {
    const parsed = parseGeo(value);
    if (parsed === null) {
      throw new DataSourceError(
        `"${value}" is not a GEO series accession (GSE…) or GEO link.`,
        DataSourceErrorCode.INVALID_FORMAT,
        'link',
        { input: value }
      );
    }
    const [accession, requested = null] = parsed.split(/\/(.*)/s);
    const folder = geoSupplementaryUrl(accession);
    let fileName = requested;
    if (fileName === null) {
      onStep?.(`Listing the files of ${accession}`);
      const response = await fetchWhenNotBusy(folder, { signal });
      if (!response.ok) {
        throw new DataSourceError(
          response.status === 404
            ? `GEO series ${accession} has no supplementary files. Check the accession on GEO.`
            : `GEO series ${accession} could not be listed (HTTP ${response.status}). Try again later.`,
          response.status === 404
            ? DataSourceErrorCode.NOT_FOUND
            : DataSourceErrorCode.NETWORK_ERROR,
          'link',
          { accession }
        );
      }
      const files = parseGeoListing(await response.text());
      // GEO bundles supplementary files in archives (`_RAW.tar`, `.zip`):
      // only a file that is itself one dataset opens.
      const endings = namesOfLayout('file').join(' or ');
      const datasets = files.filter(name => fileFormatOfName(name)?.layout === 'file');
      if (datasets.length === 0) {
        const compressed = files.filter(name => compressedFormatOfName(name)?.layout === 'file');
        throw new DataSourceError(
          compressed.length > 0
            ? `GEO series ${accession} ships its AnnData only gzip-compressed ` +
              `(${compressed.join(', ')}), which cannot be read in place. ` +
              `Download and decompress it, then open the ${endings} file in Cellucid.`
            : `GEO series ${accession} has no ${endings} supplementary file` +
              (files.length > 0 ? ` (it has: ${files.join(', ')}).` : '.'),
          DataSourceErrorCode.UNSUPPORTED,
          'link',
          { accession, files }
        );
      }
      if (datasets.length > 1) {
        throw new DataSourceError(
          `GEO series ${accession} has ${datasets.length} ${endings} files. Open one ` +
          `of them: ${datasets.map(name => `geo:${accession}/${name}`).join(', ')}.`,
          DataSourceErrorCode.VALIDATION_ERROR,
          'link',
          { accession, files: datasets }
        );
      }
      fileName = datasets[0];
    }
    const file = await describeRemoteFile({
      url: `${folder}${encodeURIComponent(fileName)}`,
      id: `geo:${accession}:${encodeURIComponent(fileName)}`,
      name: fileName,
      title: `${accession} ${titleOfName(fileName)}`,
      attribution: {
        title: `NCBI GEO ${accession}`,
        url: `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${accession}`,
      },
      signal,
      onStep,
    });
    return { title: `${accession} / ${fileName}`, file, attribution: file.attribution };
  },
});
