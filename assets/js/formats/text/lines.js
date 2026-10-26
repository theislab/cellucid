/**
 * Text files read once from the start, decompressed as they arrive (gzip,
 * bzip2, xz: `formats/rds/stream.js`), split into lines without decoding
 * more than one line at a time.
 *
 * @module formats/text/lines
 */

import { decompressed, readInOrder } from '../rds/stream.js';

export { readInOrder };

/**
 * The decompressed bytes of a text file, in pieces.
 *
 * @param {{size: number, read: Function}} file - A byte reader
 * @param {{signal?: AbortSignal|null, activity?: Object|null, onBytes?: Function|null, head?: boolean}} [options]
 *   `head`: only the start of the file is read (a header), so a large
 *   file's decompression is not given a worker of its own
 * @returns {Promise<AsyncIterable<Uint8Array>>}
 */
export async function textPieces(file, { signal = null, activity = null, onBytes = null, head = false } = {}) {
  if (file.size === 0) return (async function* empty() {})();
  const { pieces } = await decompressed(readInOrder(file, { signal, activity, onBytes }), { signal, bytes: head ? null : file.size });
  return pieces;
}

/**
 * Call `onLine(bytes, start, end)` for every line of the pieces (without its
 * `\n` or `\r\n`); `bytes` is valid only during the call. Stops early when
 * `onLine` returns `false`.
 *
 * @param {AsyncIterable<Uint8Array>} pieces
 * @param {(bytes: Uint8Array, start: number, end: number) => (boolean|void)} onLine
 */
export async function forEachLine(pieces, onLine) {
  let carry = null;
  for await (const piece of pieces) {
    let bytes = piece;
    let start = 0;
    if (carry !== null) {
      const newline = piece.indexOf(0x0a);
      if (newline < 0) {
        const joined = new Uint8Array(carry.length + piece.length);
        joined.set(carry);
        joined.set(piece, carry.length);
        carry = joined;
        continue;
      }
      const line = new Uint8Array(carry.length + newline);
      line.set(carry);
      line.set(piece.subarray(0, newline), carry.length);
      carry = null;
      let end = line.length;
      if (end > 0 && line[end - 1] === 0x0d) end--;
      if (onLine(line, 0, end) === false) return;
      start = newline + 1;
    }
    for (;;) {
      const newline = bytes.indexOf(0x0a, start);
      if (newline < 0) break;
      let end = newline;
      if (end > start && bytes[end - 1] === 0x0d) end--;
      if (onLine(bytes, start, end) === false) return;
      start = newline + 1;
    }
    if (start < bytes.length) carry = bytes.slice(start);
  }
  if (carry !== null && carry.length > 0) {
    let end = carry.length;
    if (carry[end - 1] === 0x0d) end--;
    onLine(carry, 0, end);
  }
}

const UTF8 = new TextDecoder('utf-8');

/** One line's text. */
export function lineText(bytes, start, end) {
  return UTF8.decode(bytes.subarray(start, end));
}

/**
 * The fields of one delimited line: `delimiter` a character, or null for
 * runs of spaces and tabs. Double-quoted fields (RFC 4180) may hold the
 * delimiter and doubled quotes.
 *
 * @param {string} line
 * @param {string|null} delimiter
 * @returns {string[]}
 */
export function splitFields(line, delimiter) {
  if (delimiter === null) return line.trim().split(/[ \t]+/);
  if (!line.includes('"')) return line.split(delimiter);
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      fields.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * The delimiter of a table from its first lines: tab, comma, or (when a
 * line holds neither) runs of white space.
 *
 * @param {string[]} lines
 * @returns {string|null}
 */
export function delimiterOf(lines) {
  const sample = lines.filter(line => line.length > 0).slice(0, 20);
  const count = (line, c) => line.split(c).length - 1;
  const tabs = sample.map(line => count(line, '\t'));
  const commas = sample.map(line => count(line.replace(/"[^"]*"/g, ''), ','));
  if (tabs.length > 0 && tabs.every(n => n > 0)) return '\t';
  if (commas.length > 0 && commas.every(n => n > 0)) return ',';
  if (tabs.some(n => n > 0)) return '\t';
  if (commas.some(n => n > 0)) return ',';
  return null;
}
