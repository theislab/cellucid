/**
 * The names that become paths of a store a writer of the app makes: the
 * portable element-name rule of the Cellucid-ready AnnData specification
 * (§1), as cellucid-python (`prepare_data/_inputs.py`
 * `require_element_key`, `require_distinct_element_keys`) and cellucid-r
 * apply it, in their words.
 *
 * Each name is a folder of a Zarr store, an entry name of a `.zarr.zip`
 * someone may unpack, and a group member of an `.h5ad`: no `/ \ < > : " | ?
 * *` or control character, not `.` or `..` or a Zarr metadata name, no
 * trailing space or dot, no Windows device name, and names side by side in
 * one group differ by more than letter case (and Unicode form: `é` written
 * as one code point or as `e` and an accent are one name to a file system
 * that normalises, and to a ZIP reader that does).
 *
 * @module data/anndata/write/names
 */

/** What cannot appear in a file name on every platform, with the path separators and control characters. */
const FORBIDDEN = /[/\\<>:"|?*\u0000-\u001f]/;
/** The names of a Zarr store's metadata documents (cellucid-python's `ZARR_METADATA_NAMES`). */
export const ZARR_METADATA_NAMES = Object.freeze(['.zarray', '.zattrs', '.zgroup', '.zmetadata', 'zarr.json']);
const DEVICE_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

/**
 * `key` as one portable path component, or a `TypeError` saying why not.
 *
 * @param {unknown} key
 * @param {string} what - What it names ("The obs column"), for the sentence
 * @returns {string}
 */
export function requireElementKey(key, what) {
  if (typeof key !== 'string' || key === '') throw new TypeError(`${what} names must be non-empty text; got ${JSON.stringify(key) ?? String(key)}.`);
  let problem = null;
  if (FORBIDDEN.test(key)) problem = 'contains a character that cannot appear in a file name on every platform (/ \\ < > : " | ? * or a control character)';
  else if (key === '.' || key === '..' || ZARR_METADATA_NAMES.includes(key)) problem = 'is reserved by the Zarr store layout';
  else if (key.endsWith(' ') || key.endsWith('.')) problem = 'ends with a space or a dot, which Windows removes from file names';
  else if (DEVICE_NAMES.has(key.split('.', 1)[0].toUpperCase())) problem = 'is a reserved device name on Windows';
  if (problem !== null) throw new TypeError(`${what} '${key}' ${problem}. It becomes a path in the store, so rename it.`);
  return key;
}

/** The form two names that are one folder share: Unicode composed (NFC), letter case folded. */
export function folderKey(name) {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Names side by side in one group: each distinct by more than letter case
 * and Unicode form, or a `TypeError` naming the two.
 *
 * @param {Iterable<string>} keys
 * @param {string} what
 */
export function requireDistinctElementKeys(keys, what) {
  const seen = new Map();
  for (const key of keys) {
    const folded = folderKey(key);
    if (seen.has(folded)) {
      const first = seen.get(folded);
      if (first === key) throw new TypeError(`${what} name '${key}' is used twice.`);
      throw new TypeError(
        `${what} names '${first}' and '${key}' differ only in letter case or Unicode form. They become folders of one ` +
        'Zarr group, which macOS and Windows take for one folder, so rename one of them.'
      );
    }
    seen.set(folded, key);
  }
}
