/**
 * Entry names: decoding the stored bytes and refusing unsafe paths.
 *
 * A ZIP stores each name as bytes. With general-purpose flag 11 set they are
 * UTF-8. Without it the specification says IBM code page 437, but many
 * writers (macOS Finder, most Unix tools) store UTF-8 and leave the flag
 * clear, so bytes that are valid UTF-8 are read as UTF-8 and only the rest
 * as code page 437.
 *
 * A name becomes a store path only if it is relative, uses `/`, and has no
 * empty, `.` or `..` parts: an archive can never address anything outside
 * itself. Parts are normalised to Unicode NFC, so a name written on macOS
 * (decomposed) and one written elsewhere (composed) are the same path.
 *
 * @module formats/zip/names
 */

import { ZipFormatError } from './errors.js';

const UTF8_FLAG = 0x0800;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Code page 437, bytes 0x80-0xff. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeCp437(bytes) {
  let text = '';
  for (const byte of bytes) text += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  return text;
}

/**
 * The text of a stored entry name.
 *
 * @param {Uint8Array} bytes
 * @param {number} flags - General-purpose bit flags
 * @returns {string}
 */
export function decodeEntryName(bytes, flags) {
  if (bytes.length === 0) throw new ZipFormatError('The archive has an entry with an empty name.');
  try {
    return utf8.decode(bytes);
  } catch (cause) {
    if ((flags & UTF8_FLAG) !== 0) {
      throw new ZipFormatError('The archive has an entry name marked UTF-8 that is not valid UTF-8.', { cause });
    }
    return decodeCp437(bytes);
  }
}

/**
 * The store path of an entry name, or an error when the name could address
 * something outside the archive.
 *
 * @param {string} name
 * @returns {{path: string, isDirectory: boolean}}
 */
export function entryPath(name) {
  if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) ||
      /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ZipFormatError(`The archive has an unsafe entry path '${name}'.`);
  }
  const isDirectory = name.endsWith('/');
  const parts = (isDirectory ? name.slice(0, -1) : name).split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new ZipFormatError(`The archive has an unsafe entry path '${name}'.`);
  }
  return { path: parts.map(part => part.normalize('NFC')).join('/'), isDirectory };
}

/**
 * Whether a path is metadata macOS adds when it zips a folder (`__MACOSX/`
 * resource forks, Finder's `.DS_Store`): never part of what was zipped.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isMacOSMetadata(path) {
  return path === '__MACOSX' || path.startsWith('__MACOSX/') ||
    path === '.DS_Store' || path.endsWith('/.DS_Store');
}
