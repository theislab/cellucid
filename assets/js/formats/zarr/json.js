/**
 * Zarr metadata JSON, read the way Python wrote it.
 *
 * Two things a plain `JSON.parse` gets wrong in real stores:
 *
 * - Python's `json` writes `NaN`, `Infinity` and `-Infinity` bare (zarr-python
 *   v2 attributes holding a float NaN do), which is not JSON.
 * - A 64-bit integer (an int64 fill value, an attribute) loses its low digits
 *   as a JavaScript number. Integers outside the safe range become `BigInt`,
 *   as the store contract asks.
 *
 * Text with neither (almost all metadata) goes through the native parser;
 * text that might hold either is read by a small exact parser.
 *
 * @module formats/zarr/json
 */

import { ZarrFormatError } from './errors.js';

/** A run of 16 or more digits may be an integer past the safe range. */
const LONG_DIGITS = /\d{16,}/;

/**
 * Parse metadata text.
 *
 * @param {string} text
 * @param {string} what - The file, for messages
 * @returns {unknown}
 */
export function parseJson(text, what) {
  if (!LONG_DIGITS.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      // Bare NaN or Infinity, or not JSON at all: the exact parser decides.
    }
  }
  return new Parser(text, what).document();
}

class Parser {
  constructor(text, what) {
    this.text = text;
    this.at = 0;
    this.what = what;
  }

  fail(detail) {
    return new ZarrFormatError(`${this.what} is not valid JSON: ${detail} at character ${this.at}.`);
  }

  space() {
    const text = this.text;
    while (this.at < text.length) {
      const c = text.charCodeAt(this.at);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.at++;
      else break;
    }
  }

  document() {
    const value = this.value();
    this.space();
    if (this.at !== this.text.length) throw this.fail('unexpected text after the value');
    return value;
  }

  literal(word, value) {
    if (!this.text.startsWith(word, this.at)) throw this.fail('unexpected text');
    this.at += word.length;
    return value;
  }

  value() {
    this.space();
    const c = this.text[this.at];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') return this.string();
    if (c === 't') return this.literal('true', true);
    if (c === 'f') return this.literal('false', false);
    if (c === 'n') return this.literal('null', null);
    if (c === 'N') return this.literal('NaN', Number.NaN);
    if (c === 'I') return this.literal('Infinity', Number.POSITIVE_INFINITY);
    if (c === '-' && this.text[this.at + 1] === 'I') {
      this.at++;
      return this.literal('Infinity', Number.NEGATIVE_INFINITY);
    }
    return this.number();
  }

  object() {
    this.at++;
    const result = {};
    this.space();
    if (this.text[this.at] === '}') {
      this.at++;
      return result;
    }
    for (;;) {
      this.space();
      if (this.text[this.at] !== '"') throw this.fail('expected a key');
      const key = this.string();
      this.space();
      if (this.text[this.at] !== ':') throw this.fail('expected ":"');
      this.at++;
      Object.defineProperty(result, key, { value: this.value(), enumerable: true, writable: true, configurable: true });
      this.space();
      const c = this.text[this.at++];
      if (c === '}') return result;
      if (c !== ',') throw this.fail('expected "," or "}"');
    }
  }

  array() {
    this.at++;
    const result = [];
    this.space();
    if (this.text[this.at] === ']') {
      this.at++;
      return result;
    }
    for (;;) {
      result.push(this.value());
      this.space();
      const c = this.text[this.at++];
      if (c === ']') return result;
      if (c !== ',') throw this.fail('expected "," or "]"');
    }
  }

  string() {
    const start = this.at;
    const text = this.text;
    let end = start + 1;
    for (;;) {
      if (end >= text.length) throw this.fail('unterminated string');
      const c = text.charCodeAt(end);
      if (c === 34) break;
      if (c === 92) end++;
      end++;
    }
    this.at = end + 1;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      this.at = start;
      throw this.fail('invalid string');
    }
  }

  number() {
    const match = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
    match.lastIndex = this.at;
    const found = match.exec(this.text);
    if (found === null || found[0] === '' || found[0] === '-') throw this.fail('unexpected text');
    this.at += found[0].length;
    const text = found[0];
    if (found[1] === undefined && found[2] === undefined) {
      const value = Number(text);
      return Number.isSafeInteger(value) ? value : BigInt(text);
    }
    return Number(text);
  }
}

/**
 * Freeze a parsed value and everything in it.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
