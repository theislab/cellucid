/**
 * The viewer channel's rules (`data/viewer-protocol.js`) are one document,
 * `tests/fixtures/viewer-protocol.json`, that cellucid-python
 * (`tests/fixtures/viewer_protocol.json`, checked against
 * `cellucid.jupyter._wire` and `cellucid._viewer_channel`) and cellucid-r
 * (`tests/testthat/fixtures/viewer_protocol.json`) keep byte for byte at the
 * same digest. Every example frame in it must be one the viewer would send
 * or accept: the viewer receives the commands, text and binary, and sends
 * the events.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateDataMapping } from '../assets/js/data/data-mapping.js';
import {
  VIEWER_BINARY_COMMAND_HEADER_FIELDS,
  VIEWER_BINARY_EVENT_HEADER_FIELDS,
  VIEWER_COMMAND_FIELDS,
  VIEWER_EVENT_FIELDS,
  VIEWER_RESULT_META_FIELDS,
  decodeViewerBinaryCommand,
  decodeViewerResult,
  encodeViewerResult,
  encodeViewerBinaryCommand,
  encodeViewerBinaryFrame,
  encodeViewerCells,
  viewerBinaryCommandTypes,
  viewerCommandTypes,
  viewerEventTypes,
  viewerProtocolDocumentFixture,
  viewerProtocolJson,
} from '../assets/js/data/viewer-protocol.js';
import { requireViewerHostProtocolPayload } from '../assets/js/data/viewer-host-source.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/viewer-protocol.json');

/**
 * The digest of `viewer-protocol.json`. cellucid-python
 * (`tests/test_viewer_channel_contract.py`) and cellucid-r pin the same one.
 */
const VIEWER_PROTOCOL_SHA256 = 'bf1db1f20d75f72359eea882297e880b9092f7682525f1caa56bdc8148b2b936';

test('viewer-protocol.json is the protocol module\'s document, byte for byte, at the pinned digest', () => {
  const bytes = readFileSync(FIXTURE, 'utf8');
  assert.equal(
    bytes,
    viewerProtocolJson(),
    'Regenerate it: node --input-type=module -e "import(\'./assets/js/data/viewer-protocol.js\')' +
    '.then(m => process.stdout.write(m.viewerProtocolJson()))" > tests/fixtures/viewer-protocol.json, ' +
    'then copy it to cellucid-python and cellucid-r and update the three digests.'
  );
  assert.equal(createHash('sha256').update(bytes).digest('hex'), VIEWER_PROTOCOL_SHA256);
});

test('the published protocol document is what the viewer requires of a host', () => {
  const document = viewerProtocolDocumentFixture();
  const parsed = requireViewerHostProtocolPayload(document.protocolDocument);
  assert.equal(parsed.channel, '_cellucid/ws');
  assert.deepEqual([...parsed.commands], viewerCommandTypes());
  assert.deepEqual([...parsed.binaryCommands], viewerBinaryCommandTypes());
  assert.deepEqual([...parsed.events], viewerEventTypes());
});

test('every example command carries exactly its type\'s keys, and its mapping is canonical', () => {
  const { examples } = viewerProtocolDocumentFixture();
  const types = new Set();
  for (const command of examples.commands) {
    assert.deepEqual(Object.keys(command).sort(), [...VIEWER_COMMAND_FIELDS[command.type]].sort());
    types.add(command.type);
    if (command.type === 'setDataMapping') {
      assert.deepEqual(validateDataMapping(command.mapping, { label: 'example' }), command.mapping);
    }
  }
  assert.deepEqual([...types].sort(), Object.keys(VIEWER_COMMAND_FIELDS).sort(), 'one example per text command');
});

test('the viewer reads every example binary command, cells and all', () => {
  const { examples } = viewerProtocolDocumentFixture();
  const types = new Set();
  for (const example of examples.binaryCommands) {
    const bytes = Uint8Array.from(Buffer.from(example.hex, 'hex'));
    assert.deepEqual(Object.keys(example.header).sort(), [...VIEWER_BINARY_COMMAND_HEADER_FIELDS[example.header.type]].sort());
    // Hosts pad the header so the cells start on a 4-byte boundary.
    assert.equal(new DataView(bytes.buffer).getUint32(0, true) % 4, 0);
    const command = decodeViewerBinaryCommand(bytes.buffer);
    types.add(example.header.type);
    if (example.header.type === 'setField') {
      // A pushed column: its cells (null: every cell) and its values.
      const { cells: _count, values: valueType, ...rest } = example.header;
      assert.deepEqual(
        { ...command, cells: command.cells === null ? null : [...command.cells], values: [...command.values] },
        { ...rest, cells: example.cells, values: example.values }
      );
      assert.equal(command.values.constructor.name.toLowerCase().replace('array', ''), valueType);
      const ValueArray = command.values.constructor;
      assert.deepEqual(
        encodeViewerBinaryCommand(
          example.header,
          example.cells === null ? null : Uint32Array.from(example.cells),
          ValueArray.from(example.values)
        ),
        bytes
      );
      continue;
    }
    const { all, ...rest } = example.header;
    assert.deepEqual(
      { ...command, cells: command.cells === null ? [] : [...command.cells] },
      { ...rest, cells: example.cells }
    );
    assert.equal(command.cells === null, all === true);
    if (command.cells !== null) {
      assert.equal(command.cells.buffer, bytes.buffer, 'the cells are read in place');
    }
    assert.deepEqual(
      encodeViewerBinaryCommand(example.header, all ? null : Uint32Array.from(example.cells)),
      bytes
    );
  }
  assert.deepEqual([...types].sort(), viewerBinaryCommandTypes(), 'one example per binary command');
  // A body that does not start on a 4-byte boundary is read with one copy.
  const unpadded = (() => {
    const header = new TextEncoder().encode('{"type":"highlight","color":"#000000","label":null}');
    const bytes = new Uint8Array(4 + header.length + 8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, header.length, true);
    bytes.set(header, 4);
    view.setUint32(4 + header.length, 4, true);
    view.setUint32(8 + header.length, 9, true);
    return bytes;
  })();
  assert.deepEqual([...decodeViewerBinaryCommand(unpadded).cells], [4, 9]);
  assert.throws(() => encodeViewerBinaryCommand({ type: 'highlight', color: '#000000', label: null }, null), /names its cells/);
  assert.throws(
    () => encodeViewerBinaryCommand({ type: 'setVisibility', visible: true, all: true }, Uint32Array.of(1)),
    /names its cells/
  );
  assert.throws(() => encodeViewerBinaryCommand({ type: 'highlight' }, Uint32Array.of(1)), /exactly the keys/);
  assert.throws(() => encodeViewerBinaryCommand({ type: 'setColorBy', field: 'x' }, Uint32Array.of(1)), /exactly the keys/);
  assert.throws(() => decodeViewerBinaryCommand(Uint8Array.of(...unpadded, 0)), /uint32 cell indices/);
});

test('every example event carries exactly its type\'s keys', () => {
  const { examples } = viewerProtocolDocumentFixture();
  const types = new Set();
  for (const event of examples.events) {
    assert.deepEqual(Object.keys(event).sort(), [...VIEWER_EVENT_FIELDS[event.type]].sort());
    types.add(event.type);
  }
  assert.deepEqual([...types].sort(), Object.keys(VIEWER_EVENT_FIELDS).sort(), 'one example per text event');
});

test('binary frames are the header length, the JSON header and the body', () => {
  const { examples } = viewerProtocolDocumentFixture();
  for (const example of examples.binaryEvents) {
    const bytes = Uint8Array.from(Buffer.from(example.hex, 'hex'));
    const headerLength = new DataView(bytes.buffer).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength)));
    assert.deepEqual(header, example.header);
    assert.deepEqual(
      Object.keys(header).sort(),
      [...VIEWER_BINARY_EVENT_HEADER_FIELDS[header.type]].sort()
    );
  }
  assert.throws(
    () => encodeViewerBinaryFrame({ type: 'selection' }, new Uint8Array(0)),
    /exactly the keys/
  );
  assert.throws(
    () => encodeViewerBinaryFrame({ type: 'hover', cell: 1, position: null }, new Uint8Array(0)),
    /exactly the keys/
  );
  assert.throws(() => encodeViewerCells(Uint32Array.of()), /at least one/);
  assert.throws(() => encodeViewerCells(Uint32Array.of(3, 3)), /ascending/);
  assert.throws(() => encodeViewerCells([1, 2]), /Uint32Array/);
});

test('every result kind has an example, and each reads back to its cells and values', () => {
  const { examples, results } = viewerProtocolDocumentFixture();
  const resultExamples = examples.binaryEvents.filter(example => example.header.type === 'result');
  assert.deepEqual(
    [...new Set(resultExamples.map(example => example.header.kind))].sort(),
    Object.keys(VIEWER_RESULT_META_FIELDS).sort(),
    'one example per result kind'
  );
  assert.deepEqual(Object.keys(results.kinds).sort(), Object.keys(VIEWER_RESULT_META_FIELDS).sort());
  for (const example of resultExamples) {
    const decoded = decodeViewerResult(Uint8Array.from(Buffer.from(example.hex, 'hex')));
    assert.deepEqual(decoded.header, example.header);
    assert.deepEqual(decoded.cells === null ? null : [...decoded.cells], example.cells);
    assert.deepEqual(decoded.values === null ? null : [...decoded.values], example.values);
  }
});

test('a result the protocol cannot carry is refused before it is sent', () => {
  const base = {
    requestId: null, epoch: '00000000deadbeef', revision: 1, kind: 'highlight', id: 'highlight_1', nObs: 10,
    meta: { label: 'L', tool: 'lasso', pageId: 'page_1', pageName: 'P', color: '#000000', enabled: true },
    cells: Uint32Array.of(1, 2), values: null,
  };
  assert.ok(encodeViewerResult(base).header);
  for (const epoch of [undefined, '', 'DEADBEEF00000000', '0123456789abcde', 7]) {
    assert.throws(() => encodeViewerResult({ ...base, epoch }), /epoch/);
  }
  assert.throws(() => encodeViewerResult({ ...base, cells: Uint32Array.of(2, 1) }), /ascending/);
  assert.throws(() => encodeViewerResult({ ...base, cells: Uint32Array.of(1, 10) }), /dataset has 10 cells/);
  assert.throws(() => encodeViewerResult({ ...base, meta: { ...base.meta, tool: 'brush' } }), /highlight tools/);
  assert.throws(() => encodeViewerResult({ ...base, revision: 0 }), /revision/);
  const categorical = {
    ...base, kind: 'categorical', id: 'user_cat_1',
    meta: { key: 'k', categories: ['a', 'b'], origin: 'user' }, cells: null,
  };
  assert.throws(() => encodeViewerResult({ ...categorical, values: Uint8Array.of(0, 1, 2, 0, 0, 0, 0, 0, 0, 0) }), /names no category/);
  assert.ok(encodeViewerResult({ ...categorical, values: new Uint8Array(10).fill(255) }));
  assert.throws(() => encodeViewerResult({ ...categorical, values: new Uint8Array(9) }), /9 values for 10 cells/);
  const continuous = { ...base, kind: 'continuous', id: 'c', meta: { key: 'k', origin: 'notebook' }, cells: Uint32Array.of(3) };
  assert.ok(encodeViewerResult({ ...continuous, values: Float32Array.of(NaN) }));
  assert.throws(() => encodeViewerResult({ ...continuous, values: Float32Array.of(Infinity) }), /finite/);
  assert.throws(
    () => encodeViewerBinaryCommand({
      type: 'setField', requestId: 'r', key: 'k', kind: 'continuous', categories: ['a'], nObs: 2, cells: null, values: 'float32',
    }, null, Float32Array.of(1, 2)),
    /no categories/
  );
});

test('the channel and the viewer never carry the retired notebook transport', () => {
  for (const file of ['data/viewer-host-source.js', 'data/viewer-channel.js', 'data/remote-source.js', 'app/main.js']) {
    const source = readFileSync(path.join(ROOT, 'assets/js', file), 'utf8');
    assert.doesNotMatch(source, /postMessage|ws_port|_cellucid\/(?:events|selection|session_bundle)\b/, file);
  }
});
