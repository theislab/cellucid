/**
 * What the person is told, up front, about a file that cannot be read in
 * parts: one of the formats that are one stream (`access: 'stream'` in
 * `input-formats.js`: an R object, a MatrixMarket folder), or any file on a
 * host that serves no parts of files. Such a file is read whole, once,
 * before it opens; the opening says so while it reads
 * (`data/opening-progress.js`, its `note`), and the Dataset box says what
 * became of it (`app/ui/modules/dataset-card.js`).
 *
 * Every sentence names how much is read, that what is read is kept (for
 * later visits, for the tab, or in memory: `transcode/space.js`), and what
 * is read in parts instead. One module, so the opening, the Dataset box and
 * the documentation (`cellucid-python/docs/user_guide/web_app/b_data_loading/
 * 08_which_formats_stream.md`) cannot drift apart.
 *
 * @module data/whole-read-notice
 */

import { inputFormat, isInputFormatId } from './input-formats.js';
import { PLACES, placePath } from '../app/ui/place-names.js';
import { formatBytes } from '../utils/format-units.js';

/** What is read in parts instead of a format that is one stream. */
export const READ_IN_PARTS_INSTEAD =
  'A Cellucid-ready AnnData (cellucid_prepare() in R, cellucid.prepare() in Python) is read in parts instead: only what each view needs.';

/** A format label with its article: "an R object (.rds)", "a MatrixMarket folder". */
function withArticle(label) {
  return `${/^([aeiou]|r\b)/i.test(label) ? 'an' : 'a'} ${label}`;
}

/** "all 1.2 GB of it" or "all of it" when the size is not known. */
function howMuch(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? `all ${formatBytes(bytes)} of it` : 'all of it';
}

/** Where what is read is kept, as a clause. */
function keptClause({ kept, persistent }) {
  if (kept === 'memory') return 'kept in memory until this tab closes (this browser gives this page no storage)';
  return persistent
    ? 'kept in this browser, so opening it again takes seconds'
    : 'kept in this browser until this tab closes';
}

/**
 * The note of an opening that reads a format that is one stream, or opens
 * what such a read kept before.
 *
 * @param {{format: string, bytes?: number|null, kept: 'opfs'|'memory', persistent: boolean, reused: boolean}} read
 *   `format`: the input format id; `bytes`: the file's size (a folder's:
 *   the files read); `kept`, `persistent`: where the store is kept
 *   (`transcode/session.js` `Conversion`); `reused`: opened from what an
 *   earlier read kept
 * @returns {string}
 */
export function wholeReadNote({ format, bytes = null, kept, persistent, reused }) {
  const label = isInputFormatId(format) ? inputFormat(format).label : 'file';
  if (reused) {
    return `Opened from this browser's storage, where it was kept when it was first read whole: none of the ${label} is read again.`;
  }
  const subject = withArticle(label);
  return `${subject[0].toUpperCase()}${subject.slice(1)} cannot be read in parts: ${howMuch(bytes)} is read once, ` +
    `and what Cellucid shows of it is ${keptClause({ kept, persistent })}. ${READ_IN_PARTS_INSTEAD}`;
}

/**
 * The note of an opening that downloads a file whole because its host
 * serves no parts of files.
 *
 * @param {{host: string, why: string, bytes?: number|null, kept: 'opfs'|'memory', persistent: boolean}} download
 *   `why`: the host's reason, as a clause (`link-source.js`)
 * @returns {string}
 */
export function wholeDownloadNote({ host, why, bytes = null, kept, persistent }) {
  const where = kept === 'memory'
    ? 'kept in memory until this tab closes (this browser gives this page no storage)'
    : persistent
      ? 'kept in this browser, so opening it again downloads nothing'
      : 'kept in this browser until this tab closes';
  return `${host} serves this file only whole (${why}): ${howMuch(bytes)} is downloaded once before it opens, and ${where}. ` +
    'From a host that serves parts of files (GitHub, Zenodo, Hugging Face, a static web server), only what each view needs is read.';
}

/**
 * The Dataset box's one line for a dataset read whole once.
 *
 * @param {{kept: 'opfs'|'memory', persistent?: boolean, whole?: boolean, reused: boolean}} conversion
 *   `whole: false`: an uncompressed R file, its structure read and its
 *   arrays read in place
 * @returns {string}
 */
export function wholeReadLine(conversion) {
  const read = conversion.whole === false ? 'Structure read once (arrays read in place)' : 'Read whole once (it cannot be read in parts)';
  if (conversion.kept === 'memory') return `${read}, into memory for this tab`;
  if (conversion.reused) return `Opened from this browser's storage, ${conversion.whole === false ? 'its structure read' : 'read whole'} on an earlier open`;
  return conversion.persistent === true
    ? `${read}, kept in this browser's storage for next time`
    : `${read}, into this browser's storage for this tab`;
}

/**
 * Where a dataset read whole once is kept, as the Dataset box's Details
 * row says it.
 *
 * @param {{kept: 'opfs'|'memory', persistent?: boolean, reused: boolean}} conversion
 * @returns {string}
 */
export function wholeReadKept(conversion) {
  if (conversion.kept === 'memory') {
    return 'In memory until this tab closes: this browser gives this page no storage (as in a private window)';
  }
  const where = "In this browser's storage (the origin-private file system)";
  const until = conversion.persistent === true
    ? ` until it is cleared (${placePath(PLACES.session, PLACES.openData)}: Stored, Clear) or the browser needs the room`
    : ' until this tab closes';
  return conversion.reused ? `${where}${until}; read when it was first opened, not again` : `${where}${until}`;
}
