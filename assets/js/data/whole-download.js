/**
 * A remote file whose host serves no parts of it (it ignores range
 * requests, or content-codes the file: `describeRemoteFile`'s
 * `transport: 'download'`), made ready for the reader, from a link or a
 * dataset catalog alike:
 *
 * 1. a store an earlier read of a format that is one stream kept
 *    (`transcode/space.js`) opens without downloading anything;
 * 2. else a download of it this browser kept opens from there;
 * 3. else it is downloaded whole, once, into this browser's storage as it
 *    arrives (`downloadRemoteFile`), the opening saying so up front with how
 *    much and why (`whole-read-notice.js`), its bytes counted into the
 *    Transfers log as they arrive.
 *
 * The reader then reads the kept copy under the remote file's own identity
 * (`downloaded`, `anndata/open.js`), so the store transcoded from it is
 * found again by that identity; once such a store is kept for later visits,
 * the download is removed (`afterWholeFileOpened`), unless the store reads
 * its arrays from it (an uncompressed R file). A dataset catalog's listing
 * only reads what was kept (`keptCopyOf`): it never downloads a file whole.
 *
 * @module data/whole-download
 */

import { findKeptDownload, keptStoreManifest, keptWhere, releaseKeptDownload } from './anndata/transcode/space.js';
import { downloadRemoteFile } from './sources/remote-file.js';
import { getOpeningProgress } from './opening-progress.js';
import { getTransferLog } from './transfer-log.js';
import { inputFormat, isInputFormatId } from './input-formats.js';
import { wholeDownloadNote } from './whole-read-notice.js';
import { formatBytes } from '../utils/format-units.js';

/** Why a remote file is downloaded whole (`transport: 'download'`), in a few words. */
export function downloadReason(resource, host = new URL(resource.url).host) {
  return resource.contentCoded === true
    ? `${host} sends it compressed for transfer (Content-Encoding), which leaves no part of it readable on its own`
    : `${host} does not serve parts of files`;
}

/** Whether a format is one stream, transcoded into a kept store of its own. */
function transcoded(format) {
  return isInputFormatId(format) && inputFormat(format).access === 'stream';
}

/**
 * The remote file as the reader opens it from what this browser kept of it,
 * without downloading anything: unchanged when a kept store of it opens
 * without it (a format that is one stream), with its kept download
 * (`downloaded`, with its page checksums `downloadedChecks`, which every
 * read of it is checked against) otherwise; null when nothing is kept.
 *
 * @param {{url: string, name: string, size: number, identity?: Object}} resource
 * @param {{format?: string|null}} [options]
 * @returns {Promise<Object|null>}
 */
export async function keptCopyOf(resource, { format = null } = {}) {
  const identity = resource.identity ?? null;
  if (transcoded(format)) {
    const manifest = await keptStoreManifest(identity);
    if (manifest !== null && manifest.whole !== false) return resource;
  }
  const kept = await findKeptDownload(identity, resource.name);
  return kept === null ? null : Object.freeze({ ...resource, size: kept.file.size, downloaded: kept.file, downloadedChecks: kept.checks });
}

/**
 * The remote file as the reader opens it: what this browser kept of it
 * (`keptCopyOf`), else its download, made now.
 *
 * @param {{url: string, name: string, size: number, identity?: Object, contentCoded?: boolean}} resource
 * @param {{format?: string|null, signal?: AbortSignal|null,
 *   opening?: {step?: (text: string) => void, notice?: (text: string|null) => void}|null}} [options]
 *   `format`: the input format id it is opened as; `opening`: the opening
 *   that shows it (the opening under way by default)
 * @returns {Promise<Object>}
 */
export async function wholeFileOf(resource, { format = null, signal = null, opening = null } = {}) {
  const kept = await keptCopyOf(resource, { format });
  if (kept !== null) return kept;
  const identity = resource.identity ?? null;
  const notice = text => (opening?.notice ?? (value => getOpeningProgress().notice(value)))(text);
  const step = text => (opening?.step ?? (value => getOpeningProgress().step(value)))(text);
  const host = new URL(resource.url).host;
  const size = resource.contentCoded === true ? null : resource.size;
  step(`Downloading the whole file${size === null ? '' : ` (${formatBytes(size)})`}: ${downloadReason(resource)}`);
  notice(wholeDownloadNote({ host, why: downloadReason(resource, 'its host'), bytes: size, ...(await keptWhere(identity)) }));
  let counted = 0;
  const { file, checks } = await downloadRemoteFile(resource, {
    signal,
    onBytes: received => {
      getTransferLog().record(resource.url, { bytes: Math.max(0, received - counted), requests: counted === 0 ? 1 : 0 });
      counted = received;
    },
  });
  return Object.freeze({ ...resource, size: file.size, downloaded: file, downloadedChecks: checks });
}

/**
 * Once files read through `wholeFileOf` opened: their downloads are removed
 * when the dataset's store is kept for later visits and read nothing from
 * them (`conversion`: a format that is one stream, read whole; an
 * uncompressed R file's store reads its arrays from its download, which then
 * stays). Never throws.
 *
 * @param {Iterable<Object>} resources - What `wholeFileOf` returned (the files of a set)
 * @param {import('./anndata/transcode/session.js').Conversion|null} conversion - The opened dataset's
 */
export async function afterWholeFileOpened(resources, conversion) {
  if (conversion?.kept !== 'opfs' || conversion.persistent !== true || conversion.whole === false) return;
  for (const resource of resources) {
    if (resource?.downloaded === undefined) continue;
    await releaseKeptDownload(resource.identity ?? null).catch(() => {});
  }
}
