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
 * trailing space or dot, no Windows device name, at most 255 bytes in UTF-8
 * (the longest file name Linux, macOS and Windows all take), and names side
 * by side in one group differ by more than letter case (and Unicode form:
 * `é` written as one code point or as `e` and an accent are one name to a
 * file system that normalizes, and to a ZIP reader that does).
 *
 * A writer that copies names it did not choose (a copy of an open dataset,
 * a store converted from another format, an export) writes each under
 * `portableElementName` and says which it renamed; names a person or a
 * program chooses are refused with `requireElementKey`'s sentence instead.
 *
 * @module data/anndata/write/names
 */

import { formatCountOf } from '../../../utils/format-units.js';

/** What cannot appear in a file name on every platform, with the path separators and control characters. */
const FORBIDDEN = /[/\\<>:"|?*\u0000-\u001f]/;
/** The names of a Zarr store's metadata documents (cellucid-python's `ZARR_METADATA_NAMES`). */
export const ZARR_METADATA_NAMES = Object.freeze(['.zarray', '.zattrs', '.zgroup', '.zmetadata', 'zarr.json']);
const DEVICE_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);
/**
 * The longest name, in UTF-8 bytes, that every platform takes as a file
 * name: Linux file systems count 255 bytes, macOS 255 UTF-8 characters,
 * Windows 255 UTF-16 units, and a name's UTF-8 bytes are never fewer than
 * either of those.
 */
export const MAX_ELEMENT_NAME_BYTES = 255;
const encoder = new TextEncoder();

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
  else if (encoder.encode(key).length > MAX_ELEMENT_NAME_BYTES) problem = `is ${formatCountOf(encoder.encode(key).length, 'byte')} long in UTF-8, longer than the ${MAX_ELEMENT_NAME_BYTES} a file name may be`;
  if (problem !== null) throw new TypeError(`${what} '${key}' ${problem}. It becomes a path in the store, so rename it.`);
  return key;
}

/**
 * `name` as an element name `requireElementKey` takes, distinct (by
 * `folderKey`) from every name in `taken`, which it joins: the name itself
 * when it already is one; otherwise each forbidden character as `_`, a
 * trailing space or dot as `_`, a reserved name (`.`, `..`, a Zarr metadata
 * name, a Windows device name) or no name at all after `_`, cut to
 * `MAX_ELEMENT_NAME_BYTES` at a character boundary, and, when the result is
 * taken, `_2`, `_3`, … after it. The caller says which names it changed.
 *
 * @param {string} name
 * @param {Set<string>} taken - `folderKey`s of the names already in the group
 * @returns {string}
 */
export function portableElementName(name, taken) {
  let base = String(name).replace(new RegExp(FORBIDDEN.source, 'g'), '_').replace(/[ .]+$/, ends => '_'.repeat(ends.length));
  if (base === '' || base === '.' || base === '..' || ZARR_METADATA_NAMES.includes(base) || DEVICE_NAMES.has(base.split('.', 1)[0].toUpperCase())) {
    base = `_${base}`;
  }
  const fitted = (stem, suffix) => {
    let text = stem;
    while (encoder.encode(text + suffix).length > MAX_ELEMENT_NAME_BYTES) text = Array.from(text).slice(0, -1).join('');
    // A cut may leave a trailing space or dot again.
    return `${text.replace(/[ .]+$/, ends => '_'.repeat(ends.length))}${suffix}`;
  };
  let candidate = fitted(base, '');
  for (let n = 2; taken.has(folderKey(candidate)); n++) candidate = fitted(base, `_${n}`);
  taken.add(folderKey(candidate));
  return candidate;
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
