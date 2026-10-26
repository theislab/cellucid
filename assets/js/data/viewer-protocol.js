/**
 * The viewer channel: what a host program (the `cellucid` Python package in a
 * notebook, the `cellucid` R package's viewer) and the Cellucid viewer it
 * opens say to each other, and how.
 *
 * One WebSocket per viewer, opened by the viewer at `<serverUrl>/_cellucid/ws`
 * (`ws:` for an `http:` server, `wss:` for `https:`), so it reaches the host
 * through the same address the page and the data came from, a notebook proxy
 * included. Both directions travel on it:
 *
 * - the viewer's first frame is `hello` with the viewer id and token from its
 *   page address; the host answers `welcome`, or closes the socket with
 *   `unauthorized`. Nothing else is sent before `welcome`, and the socket is
 *   that one viewer's from then on, so no later frame carries credentials;
 * - **commands** (host → viewer): text frames, one JSON object each, keys
 *   exactly as `VIEWER_COMMAND_FIELDS` names them; a command that names
 *   cells (a highlight, a visibility change) is a **binary frame**
 *   (`VIEWER_BINARY_COMMAND_HEADER_FIELDS`, `decodeViewerBinaryCommand`);
 * - **events** (viewer → host): text frames, keys exactly as
 *   `VIEWER_EVENT_FIELDS` names them; a selection and a session bundle are
 *   **binary frames** (`VIEWER_BINARY_EVENT_HEADER_FIELDS`).
 *
 * A binary frame, either way, is a little-endian uint32 header length, that
 * many bytes of UTF-8 JSON header, then the body (`encodeViewerBinaryFrame`).
 * A body of cells is little-endian uint32 cell indices, strictly ascending:
 * a million cells are 4 MB read in place, where the same cells as JSON text
 * were 7 MB to build and parse.
 *
 * `GET /_cellucid/protocol` names the channel and lists every command the
 * host may send, which of them it sends as binary frames, and every event
 * type it accepts (`viewerProtocolDocument`): the viewer is loaded from
 * www.cellucid.com without pinning a build, so a viewer newer than the host
 * package is normal, and it sends only events the host lists.
 *
 * Python (`cellucid.jupyter._wire`) and R read the same declarations from
 * `tests/fixtures/viewer-protocol.json`, which is this module's document byte
 * for byte (`viewerProtocolJson()`).
 *
 * @module data/viewer-protocol
 */

/** The document's version: a reader of `viewer-protocol.json` checks it. */
export const VIEWER_PROTOCOL_SCHEMA = 1;

/** Where the channel is, relative to the server's base address. */
export const VIEWER_CHANNEL_PATH = '_cellucid/ws';

/**
 * The address a host opens the viewer page at: its base address with
 * `?viewer=true&viewerId=…&viewerToken=…`, and `&anndata=true` when it serves
 * an AnnData-shaped store. `viewer` says the page belongs to a host program
 * (Python or R, in a notebook or not), whichever it is.
 */
export const VIEWER_PAGE_MODE_PARAMETER = 'viewer';
export const VIEWER_PAGE_PARAMETERS = Object.freeze(['viewer', 'viewerId', 'viewerToken', 'anndata']);

/**
 * The program serving a viewer, as its `GET /_cellucid/info` names it
 * (`runtime`), and what the viewer calls it: `cellucid serve` or a viewer
 * outside a notebook (`python`), a viewer in a Jupyter kernel (`jupyter`),
 * and the R package's viewer (`r`).
 */
export const VIEWER_HOST_RUNTIMES = Object.freeze({
  python: 'Python',
  jupyter: 'Jupyter',
  r: 'R',
});

/** The viewer's first frame, and the host's answer to it. */
export const VIEWER_HELLO_FIELDS = Object.freeze(['type', 'viewerId', 'viewerToken']);
export const VIEWER_WELCOME_FIELDS = Object.freeze(['type']);

/**
 * WebSocket close codes either side uses. `replaced`: the same viewer opened
 * a newer socket (its page reloaded), which the host keeps instead.
 */
export const VIEWER_CLOSE_CODES = Object.freeze({
  normal: 1000,
  goingAway: 1001,
  protocolViolation: 1008,
  unauthorized: 4401,
  replaced: 4409,
});

/** Every command a host sends as a text frame, with the exact keys it carries. */
export const VIEWER_COMMAND_FIELDS = Object.freeze({
  ping: Object.freeze(['type', 'requestId']),
  debug_snapshot: Object.freeze(['type', 'requestId']),
  requestSessionBundle: Object.freeze(['type', 'requestId']),
  clearHighlights: Object.freeze(['type']),
  setColorBy: Object.freeze(['type', 'field']),
  resetCamera: Object.freeze(['type']),
  freeze: Object.freeze(['type']),
  setDataMapping: Object.freeze(['type', 'requestId', 'mapping']),
});

/**
 * Every command a host sends as a binary frame, with the exact keys of its
 * header; the body is the cells it names. `highlight`: the cells to
 * highlight, at least one, in the `#rrggbb` `color`. `setVisibility`: the
 * cells to show or hide (`visible`), at least one; or, with `all: true`, every
 * cell, and an empty body.
 */
export const VIEWER_BINARY_COMMAND_HEADER_FIELDS = Object.freeze({
  highlight: Object.freeze(['type', 'color']),
  setVisibility: Object.freeze(['type', 'visible', 'all']),
});

/** Every event the viewer sends as a text frame, with its exact keys. */
export const VIEWER_EVENT_FIELDS = Object.freeze({
  hover: Object.freeze(['type', 'cell', 'position']),
  click: Object.freeze(['type', 'cell', 'button', 'shift', 'ctrl']),
  ready: Object.freeze(['type', 'n_cells', 'dimensions']),
  pong: Object.freeze(['type', 'requestId', 't']),
  debug_snapshot: Object.freeze([
    'type', 'requestId', 'ts', 'locationHref', 'origin', 'serverUrl', 'connected', 'userAgent',
  ]),
  command_error: Object.freeze(['type', 'command', 'reason']),
  data_mapping: Object.freeze(['type', 'requestId', 'origin', 'mapping']),
});

/**
 * Every event the viewer sends as a binary frame, with the exact keys of its
 * header. `selection`: the body is the selected cell indices, little-endian
 * uint32, strictly ascending, at least one. `session_bundle`: the body is the
 * `.cellucid-session` file the host asked for with `requestSessionBundle`.
 */
export const VIEWER_BINARY_EVENT_HEADER_FIELDS = Object.freeze({
  selection: Object.freeze(['type', 'source']),
  session_bundle: Object.freeze(['type', 'requestId']),
});

/** Why a `data_mapping` event reports the mapping it carries. */
export const VIEWER_DATA_MAPPING_ORIGINS = Object.freeze([
  'default',
  'best_guess',
  'session',
  'user',
  'notebook',
]);

/** Longest `command_error` reason the viewer sends. */
export const VIEWER_COMMAND_ERROR_REASON_LIMIT = 240;

/** Every event type, text and binary, sorted. */
export function viewerEventTypes() {
  return [...Object.keys(VIEWER_EVENT_FIELDS), ...Object.keys(VIEWER_BINARY_EVENT_HEADER_FIELDS)].sort();
}

/** Every command type, text and binary, sorted. */
export function viewerCommandTypes() {
  return [...Object.keys(VIEWER_COMMAND_FIELDS), ...Object.keys(VIEWER_BINARY_COMMAND_HEADER_FIELDS)].sort();
}

/** Every command type a host sends as a binary frame, sorted. */
export function viewerBinaryCommandTypes() {
  return Object.keys(VIEWER_BINARY_COMMAND_HEADER_FIELDS).sort();
}

/**
 * The body of `GET /_cellucid/protocol` for a host that implements every
 * command and event this module declares.
 */
export function viewerProtocolDocument() {
  return {
    channel: VIEWER_CHANNEL_PATH,
    commands: viewerCommandTypes(),
    binaryCommands: viewerBinaryCommandTypes(),
    events: viewerEventTypes(),
  };
}

const HOST_IS_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

function hasExactKeys(header, fields) {
  return (
    header !== null &&
    typeof header === 'object' &&
    !Array.isArray(header) &&
    Object.getPrototypeOf(header) === Object.prototype &&
    Object.keys(header).length === fields.length &&
    fields.every(key => Object.hasOwn(header, key))
  );
}

/**
 * `aligned`: the header is padded with spaces (still the same JSON) to a
 * multiple of 4 bytes, so the body starts on a 4-byte boundary of the frame
 * and its cells are read in place. Hosts pad every command; the viewer's
 * events are read by hosts that copy the body out anyway, and are not padded.
 */
function encodeFrame(header, body, aligned = false) {
  if (!(body instanceof Uint8Array)) {
    throw new TypeError('A binary viewer frame body must be bytes');
  }
  const text = JSON.stringify(header);
  const headerBytes = new TextEncoder().encode(aligned ? text.padEnd(text.length + ((4 - (text.length % 4)) % 4)) : text);
  const frame = new Uint8Array(4 + headerBytes.length + body.length);
  new DataView(frame.buffer).setUint32(0, headerBytes.length, true);
  frame.set(headerBytes, 4);
  frame.set(body, 4 + headerBytes.length);
  return frame;
}

/**
 * Build one binary event frame: uint32 little-endian header length, the UTF-8
 * JSON header, the body.
 *
 * @param {Object} header - Exactly the keys of its type's header
 * @param {Uint8Array} body
 * @returns {Uint8Array}
 */
export function encodeViewerBinaryFrame(header, body) {
  if (!hasExactKeys(header, VIEWER_BINARY_EVENT_HEADER_FIELDS[header?.type] ?? [null])) {
    throw new TypeError('A binary viewer event header must carry exactly the keys of its type');
  }
  if (!(body instanceof Uint8Array)) {
    throw new TypeError('A binary viewer event body must be bytes');
  }
  return encodeFrame(header, body);
}

/**
 * Encode cells as the body of a frame that names them (a `selection` event, a
 * `highlight` or `setVisibility` command): the cell indices as little-endian
 * uint32, strictly ascending, at least one. The selection tools hand over an
 * ascending `Uint32Array`, the wire's own order, so encoding is one order
 * check and, on a little-endian host, no copy.
 *
 * @param {unknown} value - Ascending Uint32Array of cell indices
 * @param {string} label
 * @returns {Uint8Array}
 */
export function encodeViewerCells(value, label = 'Selection cells') {
  if (!(value instanceof Uint32Array)) {
    throw new TypeError(`${label} must be a cell list (Uint32Array)`);
  }
  const length = value.length;
  if (length === 0) {
    throw new TypeError(`${label} must contain at least one cell`);
  }
  for (let index = 1; index < length; index++) {
    if (value[index] <= value[index - 1]) {
      throw new TypeError(`${label} must hold unique cell indices in ascending order`);
    }
  }
  // A little-endian host's cells are the wire bytes already: a view, no copy
  // (the Blob the channel sends takes its own copy, once).
  if (HOST_IS_LITTLE_ENDIAN) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  const bytes = new Uint8Array(length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < length; index++) {
    view.setUint32(index * 4, value[index], true);
  }
  return bytes;
}

/**
 * Build one binary command frame, as a host does: the header (exactly its
 * type's keys) and the cells, or `null` for a `setVisibility` of every cell
 * (`all: true`). The viewer never sends one; the protocol's examples and
 * tests are built with it.
 *
 * @param {Object} header
 * @param {Uint32Array|null} cells
 * @returns {Uint8Array}
 */
export function encodeViewerBinaryCommand(header, cells) {
  if (!hasExactKeys(header, VIEWER_BINARY_COMMAND_HEADER_FIELDS[header?.type] ?? [null])) {
    throw new TypeError('A binary viewer command header must carry exactly the keys of its type');
  }
  const every = header.type === 'setVisibility' && header.all === true;
  if (every !== (cells === null)) {
    throw new TypeError('A command names its cells, or (setVisibility with all) none');
  }
  return encodeFrame(header, every ? new Uint8Array(0) : encodeViewerCells(cells, `${header.type} cells`), true);
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Read one binary command frame from the host, checked as strictly as the
 * hosts check the viewer's binary events: the header length inside the
 * frame, the header exactly its type's keys with values of their types, and
 * the body whole little-endian uint32 cell indices, strictly ascending, at
 * least one (none, and nothing else, for `setVisibility` with `all: true`).
 * The cells are a view of the frame on a little-endian host when the body
 * starts on a 4-byte boundary (hosts pad the header so it does), else one
 * copy. Whether every cell is one of the
 * dataset's is the command's to check, against the dataset it applies to.
 *
 * @param {ArrayBuffer|Uint8Array} frame
 * @returns {{type: 'highlight', color: string, cells: Uint32Array}
 *   |{type: 'setVisibility', visible: boolean, cells: Uint32Array|null}}
 */
export function decodeViewerBinaryCommand(frame) {
  const bytes = frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame;
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('A binary command must be bytes');
  }
  if (bytes.byteLength < 4) {
    throw new TypeError('A binary command is shorter than its header length');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, true);
  if (headerLength < 2 || 4 + headerLength > bytes.byteLength) {
    throw new TypeError("A binary command's header length is outside the frame");
  }
  let header;
  try {
    header = JSON.parse(STRICT_UTF8.decode(bytes.subarray(4, 4 + headerLength)));
  } catch {
    throw new TypeError('A binary command header must be one UTF-8 JSON object');
  }
  const fields = VIEWER_BINARY_COMMAND_HEADER_FIELDS[header?.type];
  if (fields === undefined || !Object.hasOwn(VIEWER_BINARY_COMMAND_HEADER_FIELDS, header.type)) {
    throw new TypeError('A binary command must be one this viewer reads as binary');
  }
  if (!hasExactKeys(header, fields)) {
    throw new TypeError(`A ${header.type} command header must carry exactly ${fields.join(', ')}`);
  }
  const start = 4 + headerLength;
  const bodyLength = bytes.byteLength - start;
  let every = false;
  if (header.type === 'highlight') {
    if (typeof header.color !== 'string') {
      throw new TypeError('A highlight command color must be text');
    }
  } else {
    if (typeof header.visible !== 'boolean' || typeof header.all !== 'boolean') {
      throw new TypeError('A setVisibility command visible and all must be true or false');
    }
    every = header.all;
  }
  if (every) {
    if (bodyLength !== 0) {
      throw new TypeError('A setVisibility command of every cell carries no cells');
    }
    return { type: header.type, visible: header.visible, cells: null };
  }
  if (bodyLength === 0 || bodyLength % 4 !== 0) {
    throw new TypeError(
      `A ${header.type} command body must be one or more little-endian uint32 cell indices`
    );
  }
  const absolute = bytes.byteOffset + start;
  let cells;
  if (!HOST_IS_LITTLE_ENDIAN) {
    cells = new Uint32Array(bodyLength / 4);
    for (let index = 0; index < cells.length; index++) cells[index] = view.getUint32(start + index * 4, true);
  } else if (absolute % 4 === 0) {
    cells = new Uint32Array(bytes.buffer, absolute, bodyLength / 4);
  } else {
    cells = new Uint32Array(bytes.buffer.slice(absolute, absolute + bodyLength));
  }
  for (let index = 1; index < cells.length; index++) {
    if (cells[index] <= cells[index - 1]) {
      throw new TypeError(`A ${header.type} command must list its cells strictly ascending, each once`);
    }
  }
  return header.type === 'highlight'
    ? { type: 'highlight', color: header.color, cells }
    : { type: 'setVisibility', visible: header.visible, cells };
}

/** The mapping the examples set and report. */
const EXAMPLE_MAPPING = Object.freeze({
  kind: 'anndata',
  embeddings: {
    enabled: [{ key: 'X_umap', columns: [0, 1] }],
    defaults: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null },
  },
  knn: null,
  geneNames: 'index',
  expression: 'X',
  log1p: {},
  highlyVariable: null,
  latent: null,
  vectorFields: [],
});

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** One binary command example: its header, its cells (none for every cell), its bytes. */
function binaryCommand(header, cells) {
  const frame = encodeViewerBinaryCommand(header, cells === null ? null : Uint32Array.from(cells));
  return { header, cells: cells ?? [], hex: hex(frame) };
}

/**
 * One valid frame of every kind, for the three languages' tests: each side
 * must accept every example of the direction it receives.
 */
function examples() {
  const selection = encodeViewerBinaryFrame(
    { type: 'selection', source: 'lasso' },
    encodeViewerCells(Uint32Array.of(0, 2, 7))
  );
  const bundle = encodeViewerBinaryFrame(
    { type: 'session_bundle', requestId: 'r3' },
    new TextEncoder().encode('CELLUCID_SESSION\n')
  );
  return {
    hello: { type: 'hello', viewerId: '0123456789abcdef', viewerToken: '0123456789abcdef0123456789abcdef' },
    welcome: { type: 'welcome' },
    commands: [
      { type: 'ping', requestId: 'r1' },
      { type: 'debug_snapshot', requestId: 'r2' },
      { type: 'requestSessionBundle', requestId: 'r3' },
      { type: 'clearHighlights' },
      { type: 'setColorBy', field: 'cell_type' },
      { type: 'resetCamera' },
      { type: 'freeze' },
      {
        type: 'setDataMapping',
        requestId: 'r4',
        mapping: EXAMPLE_MAPPING,
      },
    ],
    binaryCommands: [
      binaryCommand({ type: 'highlight', color: '#e41a1c' }, [0, 2, 7]),
      // Past 2^31: a cell index is a uint32, every bit of it.
      binaryCommand({ type: 'highlight', color: '#00FF7f' }, [5, 2147483648, 4294967295]),
      binaryCommand({ type: 'setVisibility', visible: false, all: false }, [1, 3]),
      binaryCommand({ type: 'setVisibility', visible: true, all: true }, null),
    ],
    events: [
      { type: 'hover', cell: 3, position: { x: 0.5, y: -1, z: 0 } },
      { type: 'hover', cell: null, position: null },
      { type: 'click', cell: 3, button: 0, shift: false, ctrl: true },
      { type: 'ready', n_cells: 100, dimensions: 2 },
      { type: 'pong', requestId: 'r1', t: 1761300000000 },
      {
        type: 'debug_snapshot',
        requestId: 'r2',
        ts: '2026-10-24T12:00:00.000Z',
        locationHref: 'http://127.0.0.1:8765/?viewer=true',
        origin: 'http://127.0.0.1:8765',
        serverUrl: 'http://127.0.0.1:8765',
        connected: true,
        userAgent: null,
      },
      { type: 'command_error', command: 'setColorBy', reason: 'no field named cell_type' },
      { type: 'data_mapping', requestId: 'r4', origin: 'notebook', mapping: EXAMPLE_MAPPING },
    ],
    binaryEvents: [
      { header: { type: 'selection', source: 'lasso' }, cells: [0, 2, 7], hex: hex(selection) },
      { header: { type: 'session_bundle', requestId: 'r3' }, bodyText: 'CELLUCID_SESSION\n', hex: hex(bundle) },
    ],
  };
}

/** The document `tests/fixtures/viewer-protocol.json` holds. */
export function viewerProtocolDocumentFixture() {
  return {
    schema: VIEWER_PROTOCOL_SCHEMA,
    channel: {
      path: VIEWER_CHANNEL_PATH,
      hello: [...VIEWER_HELLO_FIELDS],
      welcome: [...VIEWER_WELCOME_FIELDS],
      closeCodes: { ...VIEWER_CLOSE_CODES },
      binaryFrame: 'uint32 little-endian header length, UTF-8 JSON header, body',
    },
    page: { parameters: [...VIEWER_PAGE_PARAMETERS], mode: VIEWER_PAGE_MODE_PARAMETER },
    runtimes: { ...VIEWER_HOST_RUNTIMES },
    protocolDocument: viewerProtocolDocument(),
    commands: Object.fromEntries(Object.entries(VIEWER_COMMAND_FIELDS).map(([type, keys]) => [type, [...keys]])),
    binaryCommands: Object.fromEntries(
      Object.entries(VIEWER_BINARY_COMMAND_HEADER_FIELDS).map(([type, keys]) => [type, [...keys]])
    ),
    events: Object.fromEntries(Object.entries(VIEWER_EVENT_FIELDS).map(([type, keys]) => [type, [...keys]])),
    binaryEvents: Object.fromEntries(
      Object.entries(VIEWER_BINARY_EVENT_HEADER_FIELDS).map(([type, keys]) => [type, [...keys]])
    ),
    dataMappingOrigins: [...VIEWER_DATA_MAPPING_ORIGINS],
    commandErrorReasonLimit: VIEWER_COMMAND_ERROR_REASON_LIMIT,
    examples: examples(),
  };
}

/** `tests/fixtures/viewer-protocol.json`, byte for byte. */
export function viewerProtocolJson() {
  return `${JSON.stringify(viewerProtocolDocumentFixture(), null, 2)}\n`;
}
