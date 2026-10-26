/**
 * The MatrixMarket entry scanner (`formats/text/matrix-market.js`,
 * `formats/text/matrix-market-entries.js`): the entries of a 100,000-cell
 * matrix are 44 million lines, so they are gathered into blocks of whole
 * lines and each block is parsed by one scanner, on a decode worker or in
 * this thread. It must read every file exactly as the line reader does: the
 * same entries and values, the same refusals naming the same entry, whatever
 * the pieces' boundaries (a decompressor hands bytes over in pieces of any
 * size), the block size, and wherever the blocks are parsed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { configureDecodePool, decodePoolStats } from '../assets/js/formats/io/decode-pool.js';
import { readMatrixMarket } from '../assets/js/formats/text/matrix-market.js';
import { scanEntryBlock } from '../assets/js/formats/text/matrix-market-entries.js';
import { createNodeDecodeWorker } from './helpers/node-decode-worker.mjs';

after(() => configureDecodePool());

const encoder = new TextEncoder();

async function* piecesOf(bytes, cuts) {
  let last = 0;
  for (const cut of cuts) {
    yield bytes.subarray(last, cut);
    last = cut;
  }
  yield bytes.subarray(last);
}

async function read(bytes, cuts = [], { blockBytes } = {}) {
  const entries = [];
  try {
    const result = await readMatrixMarket(piecesOf(bytes, cuts), {
      onSize: () => {},
      blockBytes,
      onEntries: (rows, columns, values, count) => {
        for (let k = 0; k < count; k++) entries.push([rows[k], columns[k], Object.is(values[k], -0) ? '-0' : values[k]]);
      },
    });
    return { entries, result };
  } catch (error) {
    return { error: error.message };
  }
}

const FILES = [
  ['integer, tabs, CRLF, padding', '%%MatrixMarket matrix coordinate integer general\n%metadata_json: {}\n3 4 5\n1 1 3\n2 1 7\n 3  2\t1 \n3 4 12\r\n1 4 999999999999999\n'],
  ['real: decimals, exponent, signs', '%%MatrixMarket matrix coordinate real general\r\n% c\r\n2 2 6\r\n1 1 1.5\r\n2 2 -0.25\r\n1 2 1e-3\r\n2 1 .5\r\n2 2 3.\r\n1 1 -0\r\n'],
  ['nan, no final line end', '%%MatrixMarket matrix coordinate real general\n2 2 3\n1 1 0.1\n2 2 123456789.123456\n1 2 nan'],
  ['pattern, empty line', '%%MatrixMarket matrix coordinate pattern general\n3 3 2\n1 2\n\n3 3 \n'],
  ['more digits than the scanner takes', '%%MatrixMarket matrix coordinate real general\n1 1 2\n1 1 1234567890123456789\n1 1 0.12345678901234567\n'],
  ['outside the matrix', '%%MatrixMarket matrix coordinate integer general\n2 2 2\n1 1 1\n3 1 2\n'],
  ['an entry with no value', '%%MatrixMarket matrix coordinate integer general\n2 2 2\n1 1\n2 1 2\n'],
  ['more entries than declared', '%%MatrixMarket matrix coordinate integer general\n2 2 1\n1 1 1\n2 2 2\n'],
  ['fewer entries than declared', '%%MatrixMarket matrix coordinate integer general\n2 2 3\n1 1 1\n2 2 2\n'],
  ['an index that is not a whole number', '%%MatrixMarket matrix coordinate integer general\n2 2 2\n1 1 1\n1.5 2 2\n'],
  ['more entries than declared, the extra one outside', '%%MatrixMarket matrix coordinate integer general\n2 2 1\n1 1 1\n3 3 2\n'],
];

test('every file reads the same whatever the pieces it arrives in and the block size', async () => {
  for (const [label, text] of FILES) {
    const bytes = encoder.encode(text);
    const whole = await read(bytes);
    for (let a = 0; a <= bytes.length; a++) {
      for (let b = a; b <= bytes.length; b += 5) {
        assert.deepEqual(await read(bytes, [a, b]), whole, `${label}, cut at ${a} and ${b}`);
      }
    }
    // Blocks of one line or less (they grow to a line), and a few lines.
    for (const blockBytes of [1, 2, 7, 16, 33]) {
      for (let a = 0; a <= bytes.length; a += 3) {
        assert.deepEqual(await read(bytes, [a], { blockBytes }), whole, `${label}, ${blockBytes}-byte blocks, cut at ${a}`);
      }
    }
  }
});

test('blocks parsed on decode workers read as blocks parsed in this thread', async () => {
  const lines = ['%%MatrixMarket matrix coordinate real general', '% c', '300 40 6000'];
  for (let k = 0; k < 6000; k++) {
    const value = k % 7 === 0 ? `${k}e-3` : k % 11 === 0 ? 'nan' : `${(k % 13) - 6}.${k % 1000}`;
    lines.push(`${1 + (k % 300)}${k % 5 === 0 ? '\t' : ' '}${1 + (k % 40)} ${value}${k % 9 === 0 ? '\r' : ''}`);
  }
  const texts = [lines.join('\n'), ...FILES.map(([, text]) => text)];
  const here = [];
  for (const text of texts) here.push(await read(encoder.encode(text), [101], { blockBytes: 256 }));
  configureDecodePool({ createWorker: () => createNodeDecodeWorker(), size: 3, minBytes: 0 });
  try {
    for (const [index, text] of texts.entries()) {
      for (const blockBytes of [64, 256, 4096]) {
        const bytes = encoder.encode(text);
        assert.deepEqual(await read(bytes, [101], { blockBytes }), here[index], `text ${index}, ${blockBytes}-byte blocks`);
        assert.equal(bytes.byteLength, encoder.encode(text).byteLength, 'pieces of the caller\'s buffer are copied, never given away');
      }
    }
    assert.ok(decodePoolStats().workers > 0, 'the blocks went to decode workers');
  } finally {
    configureDecodePool();
  }
});

test('a block is pieces of whole lines, parsed into the arrays it is given when they hold it', () => {
  const block = (text, extra = {}) => ({ parts: [encoder.encode(text)], pattern: false, rows: 2, columns: 2, values: 'float32', ...extra });
  assert.throws(() => scanEntryBlock(block('1 1 2\n2 1')), TypeError);
  assert.throws(() => scanEntryBlock({ ...block('1 1 2\n'), values: 'int8' }), TypeError);
  assert.throws(() => scanEntryBlock({ ...block('1 1 2\n'), parts: ['1 1 2\n'] }), TypeError);
  const first = scanEntryBlock({ ...block(''), parts: [encoder.encode('1 1 2\n2 '), encoder.encode('1 3\n')] });
  assert.equal(first.count, 2);
  assert.deepEqual([...first.rows.subarray(0, 2), ...first.columns.subarray(0, 2), ...first.values.subarray(0, 2)], [0, 1, 0, 0, 2, 3]);
  assert.equal(first.values instanceof Float32Array, true);
  const out = { rows: first.rows, columns: first.columns, values: first.values };
  const second = scanEntryBlock(block('2 2 9\n', { out }));
  assert.equal(second.rows, out.rows, 'the arrays given are reused');
  assert.deepEqual([second.count, second.rows[0], second.columns[0], second.values[0]], [1, 1, 1, 9]);
  const third = scanEntryBlock(block('1 1 1\n'.repeat(40), { out }));
  assert.notEqual(third.rows, out.rows, 'arrays too short for the block are replaced');
  assert.equal(third.count, 40);
});

test('the values are the numbers the text says, and refusals name the entry', async () => {
  const [first, second, third, , fifth, outside, noValue, more, fewer, notWhole, moreOutside] = await Promise.all(FILES.map(([, text]) => read(encoder.encode(text))));
  assert.deepEqual(first.entries, [[0, 0, 3], [1, 0, 7], [2, 1, 1], [2, 3, 12], [0, 3, 999999999999999]]);
  assert.deepEqual(second.entries.map(entry => entry[2]), [1.5, -0.25, 1e-3, 0.5, 3, '-0']);
  assert.deepEqual(third.entries.map(entry => entry[2]), [0.1, 123456789.123456, Number.NaN]);
  assert.deepEqual(fifth.entries.map(entry => entry[2]), [Number('1234567890123456789'), Number('0.12345678901234567')]);
  assert.match(outside.error, /Entry 2 \(3, 1\) is outside the 2 × 2 matrix/);
  assert.match(noValue.error, /Entry 1 of the MatrixMarket file has no value/);
  assert.match(more.error, /holds more than the 1 entry it declares/);
  assert.match(fewer.error, /declares 3 entries and holds 2; it is truncated/);
  assert.match(notWhole.error, /Entry 2 \(1\.5, 2\) does not name a row and a column by whole numbers/);
  assert.match(moreOutside.error, /Entry 2 \(3, 3\) is outside the 2 × 2 matrix/);
});

test('a decimal the scanner takes is the double Number() reads', async () => {
  const tokens = [];
  for (let k = 0; k < 4000; k++) {
    const digits = String(Math.floor(Math.random() * 1e15)).padStart(1 + (k % 15), '0').slice(0, 1 + (k % 15));
    const point = k % (digits.length + 1);
    tokens.push(`${k % 3 === 0 ? '-' : ''}${digits.slice(0, point)}${point < digits.length ? '.' : ''}${digits.slice(point)}`);
  }
  const text = `%%MatrixMarket matrix coordinate real general\n1 1 ${tokens.length}\n${tokens.map(token => `1 1 ${token}`).join('\n')}\n`;
  const { entries } = await read(encoder.encode(text));
  entries.forEach(([, , value], k) => {
    const expected = Number(tokens[k]);
    assert.ok(Object.is(value === '-0' ? -0 : value, expected), `${tokens[k]}: ${value} where Number() reads ${expected}`);
  });
});
