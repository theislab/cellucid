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
import { readdirSync, readFileSync } from 'node:fs';
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
  VIEWER_ACTION_STEP_FIELDS,
  VIEWER_ACTION_UNRECORDED,
  VIEWER_HISTORY_CHANGE_KINDS,
  decodeViewerBinaryCommand,
  encodeViewerLoadSession,
  requireViewerHistoryChanged,
  decodeViewerResult,
  encodeViewerAction,
  isViewerActionType,
  encodeViewerResult,
  encodeViewerBinaryFrame,
  encodeViewerCells,
  viewerBinaryCommandTypes,
  viewerCommandTypes,
  viewerEventTypes,
  viewerProtocolDocumentFixture,
  viewerProtocolJson,
} from '../assets/js/data/viewer-protocol.js';
import { requireViewerHostProtocolPayload } from '../assets/js/data/viewer-host-source.js';
import { ACTION_TYPE_PATTERN } from '../assets/js/app/actions/catalog.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/viewer-protocol.json');

test('viewer-protocol.json is the protocol module\'s document, byte for byte', () => {
  const bytes = readFileSync(FIXTURE, 'utf8');
  assert.equal(bytes, viewerProtocolJson(), 'Run node scripts/sync-shared-files.mjs (it writes the file here and its copies in cellucid-python and cellucid-r).');
});

test('the published protocol document is what the viewer requires of a host', () => {
  const document = viewerProtocolDocumentFixture();
  const parsed = requireViewerHostProtocolPayload(document.protocolDocument);
  assert.equal(parsed.channel, '_cellucid/ws');
  assert.deepEqual([...parsed.commands], viewerCommandTypes());
  assert.deepEqual([...parsed.binaryCommands], viewerBinaryCommandTypes());
  assert.deepEqual([...parsed.events], viewerEventTypes());
});

test('every example command carries exactly its type\'s keys, and each action is a text frame the viewer reads', () => {
  const { examples } = viewerProtocolDocumentFixture();
  const types = new Set();
  for (const command of examples.commands) {
    assert.deepEqual(Object.keys(command).sort(), [...VIEWER_COMMAND_FIELDS[command.type]].sort());
    types.add(command.type);
    if (command.type === 'action') {
      // Parameters without typed arrays travel as text, byte for byte the JSON of the command.
      assert.equal(encodeViewerAction(command), JSON.stringify(command));
    }
  }
  assert.deepEqual([...types].sort(), Object.keys(VIEWER_COMMAND_FIELDS).sort(), 'one example per text command');
  // A notebook turn: both keys set, or neither.
  const turned = examples.commands.filter(command => command.type === 'action' && command.turn !== null);
  assert.ok(turned.length > 0, 'an example action belongs to a turn');
  for (const command of turned) assert.ok(command.turnLabel.length > 0);
  assert.throws(() => encodeViewerAction({ requestId: 'r', action: 'color.by', params: {}, turn: 't', turnLabel: null }), /turn and the turn's label together/);
  assert.throws(() => encodeViewerAction({ requestId: 'r', action: 'color.by', params: {}, turn: null, turnLabel: 'QC' }), /turn and the turn's label together/);
  assert.throws(() => encodeViewerAction({ requestId: 'r', action: 'color.by', params: {}, turn: 'a b', turnLabel: 'QC' }), /turn must be exact text/);
});

/** An example's parameters with each of its arrays in place, as typed arrays. */
function paramsOf(example) {
  const params = structuredClone(example.header.params);
  const types = { uint8: Uint8Array, uint16: Uint16Array, uint32: Uint32Array, float32: Float32Array, float64: Float64Array };
  for (const { path: keys, type, elements } of example.arrays) {
    let node = params;
    for (const key of keys.slice(0, -1)) node = node[key];
    node[keys[keys.length - 1]] = types[type].from(elements);
  }
  return params;
}

test('the viewer reads every example binary action, every array in place, and hosts make the same bytes', () => {
  const { examples } = viewerProtocolDocumentFixture();
  for (const example of examples.binaryCommands.filter(entry => entry.header.type === 'action')) {
    const bytes = Uint8Array.from(Buffer.from(example.hex, 'hex'));
    assert.deepEqual(Object.keys(example.header).sort(), [...VIEWER_BINARY_COMMAND_HEADER_FIELDS[example.header.type]].sort());
    // Hosts pad the header so the body starts on a 4-byte boundary.
    assert.equal(new DataView(bytes.buffer).getUint32(0, true) % 4, 0);
    const headerLength = new DataView(bytes.buffer).getUint32(0, true);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))), example.header);
    const command = decodeViewerBinaryCommand(bytes.buffer);
    const expected = paramsOf(example);
    assert.deepEqual(command, {
      type: 'action', requestId: example.header.requestId, action: example.header.action, params: expected,
      turn: example.header.turn, turnLabel: example.header.turnLabel,
    });
    for (const { path: keys } of example.arrays) {
      let decoded = command.params;
      for (const key of keys) decoded = decoded[key];
      if (decoded.BYTES_PER_ELEMENT === 4) assert.equal(decoded.buffer, bytes.buffer, 'a 4-byte array is read in place');
    }
    assert.deepEqual(encodeViewerAction({
      requestId: example.header.requestId, action: example.header.action, params: expected,
      turn: example.header.turn, turnLabel: example.header.turnLabel,
    }), bytes);
  }
  assert.deepEqual(viewerBinaryCommandTypes(), ['action', 'load_session']);
  // The header is padded to 4 bytes of UTF-8, not 4 characters.
  const wide = encodeViewerAction({ requestId: 'r', action: 'highlight.cells', params: { label: 'Zellen ü→', cells: Uint32Array.of(1, 2) } });
  assert.equal(new DataView(wide.buffer).getUint32(0, true) % 4, 0);
  assert.equal(decodeViewerBinaryCommand(wide).params.cells.buffer, wide.buffer, 'the cells are read in place');
  const frame = (header, body = new Uint8Array(0)) => {
    const text = new TextEncoder().encode(JSON.stringify(header));
    const bytes = new Uint8Array(4 + text.length + body.length);
    new DataView(bytes.buffer).setUint32(0, text.length, true);
    bytes.set(text, 4);
    bytes.set(body, 4 + text.length);
    return bytes;
  };
  const cells = new Uint8Array(Uint32Array.of(4, 9).buffer);
  const header = {
    type: 'action', requestId: 'r', action: 'highlight.cells', params: {}, turn: null, turnLabel: null,
    arrays: [{ path: ['cells'], type: 'uint32', length: 2 }],
  };
  // A body that does not start on a 4-byte boundary is read with one copy.
  assert.deepEqual([...decodeViewerBinaryCommand(frame(header, cells)).params.cells], [4, 9]);
  assert.throws(() => decodeViewerBinaryCommand(frame(header, Uint8Array.of(...cells, 0))), /body must be 8 bytes/);
  assert.throws(() => decodeViewerBinaryCommand(frame({ ...header, params: { cells: [1] } }, cells)), /a key params does not hold/);
  assert.throws(() => decodeViewerBinaryCommand(frame({ ...header, arrays: [{ path: ['a', 'b'], type: 'uint32', length: 2 }] }, cells)), /leads nowhere/);
  assert.throws(() => decodeViewerBinaryCommand(frame({ ...header, arrays: [{ path: ['__proto__', 'x'], type: 'uint32', length: 2 }] }, cells)), /leads nowhere/);
  assert.throws(() => decodeViewerBinaryCommand(frame({ ...header, arrays: [{ path: ['cells', 0], type: 'uint32', length: 2 }] }, cells)), /ending in a key/);
  assert.throws(() => decodeViewerBinaryCommand(frame({ ...header, arrays: [{ path: ['cells'], type: 'int32', length: 2 }] }, cells)), /type must be one of/);
  assert.throws(() => decodeViewerBinaryCommand(frame({ ...header, arrays: [] })), /lists the arrays/);
  assert.throws(() => decodeViewerBinaryCommand(frame({ ...header, action: 'Color By' }, cells)), /dotted type/);
  assert.throws(() => decodeViewerBinaryCommand(frame({ type: 'highlight', color: '#000000', label: null }, cells)), /one this viewer reads as binary/);
  assert.throws(() => encodeViewerAction({ requestId: 'r', action: 'x.y', params: { list: [Uint32Array.of(1)] } }), /put it under a key/);
  assert.throws(() => encodeViewerAction({ requestId: 'r', action: 'x.y', params: { n: NaN } }), /number JSON cannot carry/);
  assert.throws(() => encodeViewerAction({ requestId: 'r', action: 'x.y', params: { cells: new Int32Array(1) } }), /Uint8Array, Uint16Array/);
  assert.throws(() => encodeViewerAction({ requestId: '', action: 'x.y', params: {} }), /requestId/);
});

test('a session file pushed into the viewer is one binary load_session frame, read back to its name and bytes', () => {
  const { examples, history } = viewerProtocolDocumentFixture();
  const loads = examples.binaryCommands.filter(entry => entry.header.type === 'load_session');
  assert.equal(loads.length, 1);
  for (const example of loads) {
    const bytes = Uint8Array.from(Buffer.from(example.hex, 'hex'));
    assert.deepEqual(Object.keys(example.header).sort(), [...VIEWER_BINARY_COMMAND_HEADER_FIELDS.load_session].sort());
    assert.equal(new DataView(bytes.buffer).getUint32(0, true) % 4, 0, 'the header is padded so the file starts on a 4-byte boundary');
    const command = decodeViewerBinaryCommand(bytes.buffer);
    assert.deepEqual(Object.keys(command), ['type', 'requestId', 'name', 'file']);
    assert.equal(command.name, example.header.name);
    assert.equal(new TextDecoder().decode(command.file), example.bodyText);
    assert.equal(command.file.buffer, bytes.buffer, 'the file is read in place');
    assert.deepEqual(encodeViewerLoadSession({ requestId: command.requestId, name: command.name, file: command.file }), bytes);
  }
  const file = new TextEncoder().encode('x');
  assert.throws(() => encodeViewerLoadSession({ requestId: 'r', name: 'a/b.cellucid-session', file }), /without a folder/);
  assert.throws(() => encodeViewerLoadSession({ requestId: 'r', name: 'a\\b.cellucid-session', file }), /without a folder/);
  assert.throws(() => encodeViewerLoadSession({ requestId: 'r', name: 'a.cellucid-session', file: new Uint8Array(0) }), /carries the session file/);
  assert.deepEqual(history.changeKinds, [...VIEWER_HISTORY_CHANGE_KINDS]);
});

test('every history_changed example is one the viewer would send, one per kind', () => {
  const { examples } = viewerProtocolDocumentFixture();
  const changes = examples.events.filter(event => event.type === 'history_changed');
  assert.deepEqual(changes.map(event => event.kind), [...VIEWER_HISTORY_CHANGE_KINDS]);
  for (const event of changes) assert.equal(requireViewerHistoryChanged(event), event);
  const base = changes[0];
  assert.throws(() => requireViewerHistoryChanged({ ...base, kind: 'renamed' }), /kind is one of/);
  assert.throws(() => requireViewerHistoryChanged({ ...base, head: null }), /head is an id/);
  assert.throws(() => requireViewerHistoryChanged({ ...base, extra: 1 }), /carries exactly/);
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
  const kinds = new Set();
  for (const example of examples.binaryEvents) {
    const bytes = Uint8Array.from(Buffer.from(example.hex, 'hex'));
    const headerLength = new DataView(bytes.buffer).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength)));
    assert.deepEqual(header, example.header);
    assert.deepEqual(
      Object.keys(header).sort(),
      [...VIEWER_BINARY_EVENT_HEADER_FIELDS[header.type]].sort()
    );
    kinds.add(header.type);
    if (header.type === 'action_result') {
      // The outcome is the body, UTF-8 JSON; the step is {id, label} or null.
      assert.deepEqual(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4 + headerLength))), example.outcome);
      if (header.step !== null) assert.deepEqual(Object.keys(header.step), [...VIEWER_ACTION_STEP_FIELDS]);
      // Why a change made no step: one of the closed set, or null (a step was made, or no change: a read).
      assert.ok(header.unrecorded === null || Object.hasOwn(VIEWER_ACTION_UNRECORDED, header.unrecorded), header.unrecorded);
      assert.ok(header.step === null || header.unrecorded === null, 'never a reason beside a step');
    }
  }
  assert.deepEqual([...kinds].sort(), Object.keys(VIEWER_BINARY_EVENT_HEADER_FIELDS).sort(), 'one example per binary event');
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
    epoch: '00000000deadbeef', revision: 1, kind: 'highlight', id: 'highlight_1', nObs: 10,
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
    meta: { key: 'k', categories: ['a', 'b'], colors: ['#ff9900', '#0077c8'], origin: 'user' }, cells: null,
  };
  // The colors it is shown in: one lowercase #rrggbb a category, in its order.
  for (const colors of [['#ff9900'], ['#FF9900', '#0077c8'], ['#f90', '#0077c8'], ['#ff9900', '#0077c8', '#ad50e0'], null]) {
    assert.throws(() => encodeViewerResult({ ...categorical, meta: { ...categorical.meta, colors }, values: new Uint8Array(10) }),
      /one #rrggbb color \(lowercase\) for each of its categories/);
  }
  const { colors: _colors, ...withoutColors } = categorical.meta;
  assert.throws(() => encodeViewerResult({ ...categorical, meta: withoutColors, values: new Uint8Array(10) }), /must carry exactly key, categories, colors, origin/);
  assert.throws(() => encodeViewerResult({ ...categorical, values: Uint8Array.of(0, 1, 2, 0, 0, 0, 0, 0, 0, 0) }), /names no category/);
  assert.ok(encodeViewerResult({ ...categorical, values: new Uint8Array(10).fill(255) }));
  assert.throws(() => encodeViewerResult({ ...categorical, values: new Uint8Array(9) }), /9 values for 10 cells/);
  const continuous = { ...base, kind: 'continuous', id: 'c', meta: { key: 'k', origin: 'notebook' }, cells: Uint32Array.of(3) };
  assert.ok(encodeViewerResult({ ...continuous, values: Float32Array.of(NaN) }));
  assert.throws(() => encodeViewerResult({ ...continuous, values: Float32Array.of(Infinity) }), /finite/);
});

test('the channel and the viewer never carry the retired notebook transport', () => {
  // The viewer's side of the channel: the start-up and every module of `app/viewer-host/`.
  const viewerHost = readdirSync(path.join(ROOT, 'assets/js/app/viewer-host'))
    .filter(name => name.endsWith('.js'))
    .map(name => `app/viewer-host/${name}`);
  for (const file of ['data/viewer-host-source.js', 'data/viewer-channel.js', 'data/remote-source.js', 'app/main.js', ...viewerHost]) {
    const source = readFileSync(path.join(ROOT, 'assets/js', file), 'utf8');
    assert.doesNotMatch(source, /postMessage|ws_port|_cellucid\/(?:events|selection|session_bundle)\b/, file);
  }
});

test('an action command names its action as the catalogue does: one pattern, every action', () => {
  const { action } = viewerProtocolDocumentFixture();
  assert.equal(action.typePattern, ACTION_TYPE_PATTERN.source, 'the protocol\'s copy of the action type pattern is the catalogue\'s');
  for (const definition of getActionCatalog().list()) {
    assert.ok(isViewerActionType(definition.type), `${definition.type} is a type an action command can name`);
  }
});

test('why a change made no step: one closed set, each with the sentence a host says, as an agent is told it', async () => {
  const { UNRECORDED_NOTES } = await import('../assets/js/app/agent/bridge/mcp-content.js');
  const { action, examples } = viewerProtocolDocumentFixture();
  assert.deepEqual(action.unrecorded, { ...VIEWER_ACTION_UNRECORDED });
  assert.deepEqual(Object.keys(VIEWER_ACTION_UNRECORDED), ['unchanged', 'retracted', 'off', 'paused', 'elsewhere', 'no-history']);
  assert.deepEqual(Object.keys(UNRECORDED_NOTES).sort(), Object.keys(VIEWER_ACTION_UNRECORDED).sort(), 'the agent is told each reason a host hears');
  for (const [reason, sentence] of Object.entries(VIEWER_ACTION_UNRECORDED)) {
    // Said after the call that asked ("viewer.color_by(...): …"): lower case, one sentence, no step made.
    assert.match(sentence, /^[a-z].*no step was recorded.*\.$/, reason);
  }
  // The examples show a change answered with why it made no step.
  const reasons = examples.binaryEvents.filter(example => example.header.type === 'action_result').map(example => example.header.unrecorded);
  assert.ok(reasons.includes('unchanged') && reasons.includes(null));
});
