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
 *   cells or carries a column (a highlight, a visibility change, a field) is
 *   a **binary frame** (`VIEWER_BINARY_COMMAND_HEADER_FIELDS`,
 *   `decodeViewerBinaryCommand`);
 * - **events** (viewer → host): text frames, keys exactly as
 *   `VIEWER_EVENT_FIELDS` names them; a selection, a result and a session
 *   bundle are **binary frames** (`VIEWER_BINARY_EVENT_HEADER_FIELDS`).
 *
 * A binary frame, either way, is a little-endian uint32 header length, that
 * many bytes of UTF-8 JSON header, then the body (`encodeViewerBinaryFrame`).
 * A body of cells is little-endian uint32 cell indices, strictly ascending:
 * a million cells are 4 MB read in place, where the same cells as JSON text
 * were 7 MB to build and parse.
 *
 * **Cells are original positions.** Every cell either side names -- in a
 * selection, a hover, a click, a result, a highlight or visibility command, a
 * pushed field -- is its row in the dataset's `obs` (0-based), whether the
 * viewer opened every cell or a subsample of them (`data/cell-identity.js`).
 * `nObs` in a result or a field is the dataset's whole cell count, so each
 * side checks it names the same dataset.
 *
 * **Results** are what a person made in the viewer and a host pulls back
 * into its AnnData, Seurat or SingleCellExperiment object: highlight groups
 * of every kind, user-defined categorical fields (labels, annotations,
 * clusters), continuous fields (scores, pushed columns), gene sets, the
 * filter's visible cells and the subsample the viewer opened. Each result is
 * one `result` frame (`VIEWER_RESULT_META_FIELDS`, `encodeViewerResult`):
 * its kind, a stable id, a revision, its metadata and a body of cells and
 * values. After its dataset opens (a page reload included), and whenever its
 * channel opens again, the viewer sends every result and then a `results`
 * inventory: the complete set, so a host that kept an older copy replaces it
 * whole. From then on it sends a result whenever one is made or changes, and
 * `result_removed` when one goes. A host therefore always holds every result
 * as of the last event it read, and answers "what was made" from that, with
 * no request: a notebook widget reads the viewer's messages only between
 * cells, where no call could wait for an answer.
 *
 * Every result event carries its **epoch**: one page's account of one
 * dataset it opened (`VIEWER_RESULT_EPOCH_PATTERN`, drawn at random). A new
 * page -- a reload, the viewer shown again in another notebook output -- and
 * every dataset a page opens start a new epoch, whose revisions count from 1
 * again. A host keeps the results of one epoch: an event of another epoch
 * starts it afresh, and that epoch's snapshot fills it. Within an epoch,
 * revisions grow by one with every result or removal: a frame whose revision
 * a host already holds for that id is one it has already applied. The
 * `results` inventory names the host's dataset the epoch describes
 * (`dataset`, its id in `/_cellucid/datasets`), or null when the person
 * opened another dataset in the viewer: then it lists nothing, the viewer
 * sends no result until the host's dataset is open again, and no selection,
 * hover or click either.
 *
 * A result's body is two sections, either possibly empty: `cells` original
 * positions (uint32, strictly ascending, when the header's `cells` is a
 * count; none when it is null), then `values` of the header's `values` type,
 * one per named cell, or one per cell of the dataset when `cells` is null.
 * Category codes take the type's largest value for "no category"; float
 * values take NaN for "no value". A `setField` command's body is the same.
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

import { formatCountOf } from '../utils/format-units.js';
import { allocateTypedArray } from './sparse-column-index.js';

/** The document's version: a reader of `viewer-protocol.json` checks it. */
export const VIEWER_PROTOCOL_SCHEMA = 2;

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

/**
 * Every command a host sends as a text frame, with the exact keys it carries.
 * `setGeneSet`: add the gene set `name`, or replace the one of that name
 * (answered by its `result`, carrying this `requestId`).
 */
export const VIEWER_COMMAND_FIELDS = Object.freeze({
  ping: Object.freeze(['type', 'requestId']),
  debug_snapshot: Object.freeze(['type', 'requestId']),
  requestSessionBundle: Object.freeze(['type', 'requestId']),
  clearHighlights: Object.freeze(['type']),
  setColorBy: Object.freeze(['type', 'field']),
  resetCamera: Object.freeze(['type']),
  freeze: Object.freeze(['type']),
  setDataMapping: Object.freeze(['type', 'requestId', 'mapping']),
  setGeneSet: Object.freeze(['type', 'requestId', 'name', 'description', 'genes']),
});

/**
 * Every command a host sends as a binary frame, with the exact keys of its
 * header. `highlight`: the cells to highlight, at least one, in the
 * `#rrggbb` `color`, as one group named `label` (null: the viewer names it).
 * `setVisibility`: the cells to show or hide (`visible`), at least one; or,
 * with `all: true`, every cell, and an empty body. `setField`: a column as a
 * user-defined field `key` (added, or replacing the field of that key the
 * notebook pushed before), `categorical` with its `categories` or
 * `continuous` (`categories` null); its body is a result body (cells and
 * values) of a dataset of `nObs` cells. Answered by the field's `result`.
 */
export const VIEWER_BINARY_COMMAND_HEADER_FIELDS = Object.freeze({
  highlight: Object.freeze(['type', 'color', 'label']),
  setVisibility: Object.freeze(['type', 'visible', 'all']),
  setField: Object.freeze(['type', 'requestId', 'key', 'kind', 'categories', 'nObs', 'cells', 'values']),
});

/**
 * Every event the viewer sends as a text frame, with its exact keys.
 * `ready`: the cells open (`n_cells`) and in the dataset (`n_obs`; more when
 * a subsample is open). `color_by`: the field the viewer colours by now
 * (`field` null: none), from `obs` or `var` (a gene, by its identifier: the
 * var index), and the name the viewer shows for it (`label`: a gene's
 * symbol, an obs field's key; null with no field). `result_removed`: a
 * result of `epoch` is gone. `results`: every result the viewer holds in
 * `epoch` at `revision`, each `{kind, id, revision}`, sent after every result
 * of a snapshot, and the host dataset they describe (`dataset`; null: the
 * viewer shows another dataset, and `items` is empty).
 */
export const VIEWER_EVENT_FIELDS = Object.freeze({
  hover: Object.freeze(['type', 'cell', 'position']),
  click: Object.freeze(['type', 'cell', 'button', 'shift', 'ctrl']),
  ready: Object.freeze(['type', 'n_cells', 'n_obs', 'dimensions']),
  pong: Object.freeze(['type', 'requestId', 't']),
  debug_snapshot: Object.freeze([
    'type', 'requestId', 'ts', 'locationHref', 'origin', 'serverUrl', 'connected', 'userAgent',
  ]),
  command_error: Object.freeze(['type', 'command', 'reason']),
  data_mapping: Object.freeze(['type', 'requestId', 'origin', 'mapping']),
  color_by: Object.freeze(['type', 'field', 'source', 'label']),
  result_removed: Object.freeze(['type', 'epoch', 'revision', 'kind', 'id']),
  results: Object.freeze(['type', 'epoch', 'dataset', 'revision', 'nObs', 'items']),
});

/**
 * Every event the viewer sends as a binary frame, with the exact keys of its
 * header. `selection`: the body is the selected cells (original positions),
 * little-endian uint32, strictly ascending, at least one. `session_bundle`:
 * the body is the `.cellucid-session` file the host asked for with
 * `requestSessionBundle`. `result`: one result (`encodeViewerResult`);
 * `requestId` is the `setField` or `setGeneSet` it answers, or null.
 */
export const VIEWER_BINARY_EVENT_HEADER_FIELDS = Object.freeze({
  selection: Object.freeze(['type', 'source']),
  session_bundle: Object.freeze(['type', 'requestId']),
  result: Object.freeze(['type', 'requestId', 'epoch', 'revision', 'kind', 'id', 'nObs', 'meta', 'cells', 'values']),
});

/** An epoch: 16 lowercase hexadecimal characters (64 random bits). */
export const VIEWER_RESULT_EPOCH_PATTERN = '^[0-9a-f]{16}$';
const EPOCH_PATTERN = new RegExp(VIEWER_RESULT_EPOCH_PATTERN);

/** Whether `value` is an epoch (`VIEWER_RESULT_EPOCH_PATTERN`). */
export function isViewerResultEpoch(value) {
  return typeof value === 'string' && EPOCH_PATTERN.test(value);
}

/**
 * Every kind of result, with the exact keys of its `meta`:
 *
 * - `highlight`: one highlight group: its `label`, the `tool` that made it,
 *   its page (`pageId`, `pageName`, the page's `color`) and whether it is
 *   `enabled`. Cells: its members; no values.
 * - `categorical`: a user-defined categorical field (labels, annotations,
 *   clusters): `key`, `categories`, `origin`. Values: category codes.
 * - `continuous`: a user-defined continuous field or a score: `key`,
 *   `origin`. Values: floats.
 * - `geneSet`: `name`, `description`, `genes` (by identifier: the var
 *   index, as every gene crossing the boundary), `symbols` (the name the
 *   viewer shows for each gene, in the same order: a symbol column's, or the
 *   identifier itself), `origin`. No cells (count 0), no values.
 * - `visibility`: the cells the filters leave visible (id `visible`); cells
 *   null when every cell is.
 * - `subset`: the cells the viewer opened (id `open`), with the open set's
 *   `digest` (`data/cell-identity.js`); cells null when every cell is.
 */
export const VIEWER_RESULT_META_FIELDS = Object.freeze({
  highlight: Object.freeze(['label', 'tool', 'pageId', 'pageName', 'color', 'enabled']),
  categorical: Object.freeze(['key', 'categories', 'origin']),
  continuous: Object.freeze(['key', 'origin']),
  geneSet: Object.freeze(['name', 'description', 'genes', 'symbols', 'origin']),
  visibility: Object.freeze([]),
  subset: Object.freeze(['digest']),
});

/** The tools a highlight group is made with (`meta.tool`). */
export const VIEWER_HIGHLIGHT_TOOLS = Object.freeze([
  'annotation', 'category', 'combined', 'knn', 'lasso', 'proximity', 'range',
]);

/**
 * Who made a field or gene set: the person (`user`), an analysis
 * (`analysis`: a gene signature's scores and sets), a marker genes result
 * (`markers`), or a host (`notebook`: pushed with `setField`/`setGeneSet`).
 */
export const VIEWER_RESULT_ORIGINS = Object.freeze(['analysis', 'markers', 'notebook', 'user']);

/** The kinds of field a host pushes with `setField`. */
export const VIEWER_FIELD_KINDS = Object.freeze(['categorical', 'continuous']);

/** Each value type of a body, and its size in bytes (little-endian). */
export const VIEWER_VALUE_TYPES = Object.freeze({
  uint8: 1,
  uint16: 2,
  uint32: 4,
  float32: 4,
  float64: 8,
});

const VALUE_ARRAY_TYPES = Object.freeze({
  uint8: Uint8Array,
  uint16: Uint16Array,
  uint32: Uint32Array,
  float32: Float32Array,
  float64: Float64Array,
});

const CODE_TYPES = Object.freeze(['uint8', 'uint16', 'uint32']);
const FLOAT_TYPES = Object.freeze(['float32', 'float64']);

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

function isExactText(value, { whitespace = false } = {}) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value) &&
    (whitespace || !/\s/.test(value))
  );
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * `aligned`: the header is padded with spaces (still the same JSON) to a
 * multiple of 4 bytes, so the body starts on a 4-byte boundary of the frame
 * and its cells are read in place. Hosts pad every command; the viewer's
 * events are read by hosts that copy the body out anyway, and are not padded.
 */
function encodeFrame(header, body, aligned = false) {
  const parts = Array.isArray(body) ? body : [body];
  for (const part of parts) {
    if (!(part instanceof Uint8Array)) {
      throw new TypeError('A binary viewer frame body must be bytes');
    }
  }
  const text = JSON.stringify(header);
  const headerBytes = new TextEncoder().encode(aligned ? text.padEnd(text.length + ((4 - (text.length % 4)) % 4)) : text);
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const frame = allocateTypedArray(Uint8Array, 4 + headerBytes.length + length, 'Viewer frame');
  new DataView(frame.buffer).setUint32(0, headerBytes.length, true);
  frame.set(headerBytes, 4);
  let at = 4 + headerBytes.length;
  for (const part of parts) {
    frame.set(part, at);
    at += part.length;
  }
  return frame;
}

/**
 * Build one binary event frame: uint32 little-endian header length, the UTF-8
 * JSON header, the body.
 *
 * @param {Object} header - Exactly the keys of its type's header
 * @param {Uint8Array|Uint8Array[]} body - The body, or its parts in order
 * @returns {Uint8Array}
 */
export function encodeViewerBinaryFrame(header, body) {
  if (!hasExactKeys(header, VIEWER_BINARY_EVENT_HEADER_FIELDS[header?.type] ?? [null])) {
    throw new TypeError('A binary viewer event header must carry exactly the keys of its type');
  }
  return encodeFrame(header, body);
}

/** The little-endian bytes of a typed array: a view on a little-endian host. */
function littleEndianBytes(array) {
  if (HOST_IS_LITTLE_ENDIAN || array.BYTES_PER_ELEMENT === 1) {
    return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  }
  const bytes = allocateTypedArray(Uint8Array, array.byteLength, 'Viewer frame values');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = array.BYTES_PER_ELEMENT;
  for (let index = 0; index < array.length; index++) {
    const at = index * size;
    if (array instanceof Float32Array) view.setFloat32(at, array[index], true);
    else if (array instanceof Float64Array) view.setFloat64(at, array[index], true);
    else if (array instanceof Uint16Array) view.setUint16(at, array[index], true);
    else view.setUint32(at, array[index], true);
  }
  return bytes;
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
  if (value.length === 0) {
    throw new TypeError(`${label} must contain at least one cell`);
  }
  requireAscendingCells(value, label);
  return littleEndianBytes(value);
}

function requireAscendingCells(cells, label, nObs = null) {
  for (let index = 1; index < cells.length; index++) {
    if (cells[index] <= cells[index - 1]) {
      throw new TypeError(`${label} must hold unique cell indices in ascending order`);
    }
  }
  if (nObs !== null && cells.length > 0 && cells[cells.length - 1] >= nObs) {
    throw new RangeError(`${label} names cell ${cells[cells.length - 1]}, and the dataset has ${formatCountOf(nObs, 'cell')}`);
  }
}

function valueTypeOfArray(values) {
  for (const [name, ArrayType] of Object.entries(VALUE_ARRAY_TYPES)) {
    if (values instanceof ArrayType) return name;
  }
  throw new TypeError('Values must be a Uint8Array, Uint16Array, Uint32Array, Float32Array or Float64Array');
}

/**
 * Check a body's two sections against the header that describes them:
 * cells ascending below `nObs`, values one per named cell (or per cell of the
 * dataset when `cells` is null), category codes below the category count or
 * the type's "no category" value, floats finite or NaN.
 */
function requireSections({ nObs, cells, values, categoryCount, label }) {
  if (cells !== null) requireAscendingCells(cells, `${label} cells`, nObs);
  if (values === null) return;
  const expected = cells === null ? nObs : cells.length;
  if (values.length !== expected) {
    throw new RangeError(`${label} holds ${formatCountOf(values.length, 'value')} for ${formatCountOf(expected, 'cell')}`);
  }
  if (values instanceof Float32Array || values instanceof Float64Array) {
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (value === Infinity || value === -Infinity) {
        throw new RangeError(`${label} values must be finite numbers or NaN (no value)`);
      }
    }
    return;
  }
  if (categoryCount !== null) {
    const missing = 2 ** (8 * values.BYTES_PER_ELEMENT) - 1;
    if (categoryCount > missing) {
      throw new RangeError(`${label} has ${formatCountOf(categoryCount, 'category', 'categories')}, more than its code type holds`);
    }
    for (let index = 0; index < values.length; index++) {
      const code = values[index];
      if (code >= categoryCount && code !== missing) {
        throw new RangeError(`${label} code ${code} names no category`);
      }
    }
  }
}

function requireStringList(value, label, { allowEmpty = true, whitespace = true, unique = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? 'a list' : 'a non-empty list'} of text`);
  }
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || (!whitespace && !isExactText(entry))) {
      throw new TypeError(`${label} must hold text only`);
    }
    if (unique && seen.has(entry)) throw new TypeError(`${label} must not repeat ${JSON.stringify(entry)}`);
    seen.add(entry);
  }
  return value;
}

/**
 * Check one result's `kind`, `meta` and the shape of its body (`cells`: a
 * count or null, `values`: a type or null) against the rules of its kind.
 *
 * @param {Object} header - A `result` header
 */
export function requireViewerResultHeader(header) {
  if (!hasExactKeys(header, VIEWER_BINARY_EVENT_HEADER_FIELDS.result) || header.type !== 'result') {
    throw new TypeError(`A result header must carry exactly ${VIEWER_BINARY_EVENT_HEADER_FIELDS.result.join(', ')}`);
  }
  const { requestId, epoch, revision, kind, id, nObs, meta, cells, values } = header;
  if (requestId !== null && !isExactText(requestId)) throw new TypeError('A result requestId must be exact text or null');
  if (!isViewerResultEpoch(epoch)) throw new TypeError('A result epoch must be 16 lowercase hexadecimal characters');
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('A result revision must be a positive integer');
  const metaFields = VIEWER_RESULT_META_FIELDS[kind];
  if (!Object.hasOwn(VIEWER_RESULT_META_FIELDS, kind)) throw new TypeError('A result kind must be one of the protocol\'s');
  if (!isExactText(id, { whitespace: true })) throw new TypeError('A result id must be exact text');
  if (!Number.isSafeInteger(nObs) || nObs < 0 || nObs > 0xffffffff) throw new TypeError('A result nObs must be a cell count');
  if (!hasExactKeys(meta, metaFields)) throw new TypeError(`A ${kind} result's meta must carry exactly ${metaFields.join(', ')}`);
  if (cells !== null && !isCount(cells)) throw new TypeError('A result cells must be a count or null');
  if (values !== null && !Object.hasOwn(VIEWER_VALUE_TYPES, values)) throw new TypeError('A result values must be a value type or null');
  const origin = meta.origin;
  if (metaFields.includes('origin') && !VIEWER_RESULT_ORIGINS.includes(origin)) {
    throw new TypeError(`A ${kind} result's origin must be one of ${VIEWER_RESULT_ORIGINS.join(', ')}`);
  }
  switch (kind) {
    case 'highlight':
      if (!isExactText(meta.label, { whitespace: true }) || !VIEWER_HIGHLIGHT_TOOLS.includes(meta.tool)) {
        throw new TypeError('A highlight result names its label and one of the highlight tools');
      }
      if (!isExactText(meta.pageId) || !isExactText(meta.pageName, { whitespace: true })) {
        throw new TypeError('A highlight result names its page');
      }
      if (typeof meta.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(meta.color) || typeof meta.enabled !== 'boolean') {
        throw new TypeError('A highlight result carries its page colour and whether it is enabled');
      }
      if (cells === null || cells < 1 || values !== null) {
        throw new TypeError('A highlight result names its cells, at least one, and no values');
      }
      return header;
    case 'categorical':
      if (!isExactText(meta.key, { whitespace: true })) throw new TypeError('A categorical result names its key');
      requireStringList(meta.categories, 'A categorical result\'s categories', { allowEmpty: false });
      if (!CODE_TYPES.includes(values) || cells === 0) {
        throw new TypeError('A categorical result carries category codes for its cells');
      }
      return header;
    case 'continuous':
      if (!isExactText(meta.key, { whitespace: true })) throw new TypeError('A continuous result names its key');
      if (!FLOAT_TYPES.includes(values) || cells === 0) {
        throw new TypeError('A continuous result carries float values for its cells');
      }
      return header;
    case 'geneSet':
      if (!isExactText(meta.name, { whitespace: true }) || typeof meta.description !== 'string') {
        throw new TypeError('A gene set result names its set and carries a description');
      }
      requireStringList(meta.genes, 'A gene set result\'s genes', { whitespace: false });
      requireStringList(meta.symbols, 'A gene set result\'s symbols', { whitespace: true, unique: false });
      if (meta.symbols.length !== meta.genes.length) {
        throw new TypeError('A gene set result names a symbol for each of its genes');
      }
      if (cells !== 0 || values !== null) throw new TypeError('A gene set result names no cells and no values');
      return header;
    case 'visibility':
      if (id !== 'visible' || values !== null) throw new TypeError('A visibility result is "visible" and carries no values');
      return header;
    case 'subset':
      if (id !== 'open' || values !== null || cells === 0) {
        throw new TypeError('A subset result is "open", names its open cells or null, and carries no values');
      }
      if (typeof meta.digest !== 'string' || !/^[0-9a-f]{16}$/.test(meta.digest)) {
        throw new TypeError('A subset result carries the open set\'s digest');
      }
      return header;
    default:
      throw new TypeError('Unknown result kind');
  }
}

/**
 * Build one `result` frame's header and body, checked: the header (with
 * `cells` and `values` read from the arrays given) and the body's parts in
 * order, views of the arrays on a little-endian host.
 *
 * @param {{requestId: string|null, epoch: string, revision: number, kind: string, id: string,
 *   nObs: number, meta: Object, cells: Uint32Array|null,
 *   values: Uint8Array|Uint16Array|Uint32Array|Float32Array|Float64Array|null}} result
 *   `cells`: original positions, ascending; null for every cell of the dataset
 * @returns {{header: Object, body: Uint8Array[]}}
 */
export function encodeViewerResult(result) {
  const { requestId, epoch, revision, kind, id, nObs, meta, cells, values } = result;
  if (cells !== null && !(cells instanceof Uint32Array)) {
    throw new TypeError('Result cells must be a Uint32Array of original positions or null');
  }
  const header = {
    type: 'result',
    requestId,
    epoch,
    revision,
    kind,
    id,
    nObs,
    meta,
    cells: cells === null ? null : cells.length,
    values: values === null ? null : valueTypeOfArray(values),
  };
  requireViewerResultHeader(header);
  requireSections({
    nObs,
    cells,
    values,
    categoryCount: kind === 'categorical' ? meta.categories.length : null,
    label: `The ${kind} result "${id}"`,
  });
  const body = [];
  if (cells !== null && cells.length > 0) body.push(littleEndianBytes(cells));
  if (values !== null && values.length > 0) body.push(littleEndianBytes(values));
  return { header, body };
}

/** Read `count` values of `type` at `start` of `bytes`: in place when aligned on a little-endian host. */
function readSection(bytes, start, count, type) {
  const ArrayType = VALUE_ARRAY_TYPES[type];
  const size = VIEWER_VALUE_TYPES[type];
  const absolute = bytes.byteOffset + start;
  if (HOST_IS_LITTLE_ENDIAN) {
    if (absolute % size === 0) return new ArrayType(bytes.buffer, absolute, count);
    const aligned = allocateTypedArray(ArrayType, count, 'Viewer frame values');
    new Uint8Array(aligned.buffer, aligned.byteOffset, count * size).set(bytes.subarray(start, start + count * size));
    return aligned;
  }
  const view = new DataView(bytes.buffer, absolute, count * size);
  const out = allocateTypedArray(ArrayType, count, 'Viewer frame values');
  for (let index = 0; index < count; index++) {
    const at = index * size;
    out[index] = type === 'uint8' ? view.getUint8(at)
      : type === 'uint16' ? view.getUint16(at, true)
        : type === 'uint32' ? view.getUint32(at, true)
          : type === 'float32' ? view.getFloat32(at, true)
            : view.getFloat64(at, true);
  }
  return out;
}

/**
 * Read a body of a cells section and a values section, as a header
 * describes it.
 *
 * @returns {{cells: Uint32Array|null, values: ArrayBufferView|null}}
 */
function readSections(bytes, start, { nObs, cells: cellCount, values: valueType }, label) {
  const bodyLength = bytes.byteLength - start;
  const valueCount = valueType === null ? 0 : (cellCount === null ? nObs : cellCount);
  const cellBytes = cellCount === null ? 0 : cellCount * 4;
  const expected = cellBytes + valueCount * (valueType === null ? 0 : VIEWER_VALUE_TYPES[valueType]);
  if (bodyLength !== expected) {
    throw new TypeError(`${label} body must be ${formatCountOf(expected, 'byte')} for its cells and values, not ${bodyLength}`);
  }
  const cells = cellCount === null ? null : readSection(bytes, start, cellCount, 'uint32');
  const values = valueType === null ? null : readSection(bytes, start + cellBytes, valueCount, valueType);
  return { cells, values };
}

/** The header of one binary frame and where its body starts. */
function readFrameHeader(frame, what) {
  const bytes = frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame;
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`A binary ${what} must be bytes`);
  }
  if (bytes.byteLength < 4) {
    throw new TypeError(`A binary ${what} is shorter than its header length`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, true);
  if (headerLength < 2 || 4 + headerLength > bytes.byteLength) {
    throw new TypeError(`A binary ${what}'s header length is outside the frame`);
  }
  let header;
  try {
    header = JSON.parse(STRICT_UTF8.decode(bytes.subarray(4, 4 + headerLength)));
  } catch {
    throw new TypeError(`A binary ${what} header must be one UTF-8 JSON object`);
  }
  return { bytes, header, start: 4 + headerLength };
}

/**
 * Read one `result` frame (as hosts do; the viewer's tests read its own).
 *
 * @param {ArrayBuffer|Uint8Array} frame
 * @returns {{header: Object, cells: Uint32Array|null, values: ArrayBufferView|null}}
 */
export function decodeViewerResult(frame) {
  const { bytes, header, start } = readFrameHeader(frame, 'result');
  requireViewerResultHeader(header);
  const sections = readSections(bytes, start, header, `The ${header.kind} result "${header.id}"`);
  requireSections({
    nObs: header.nObs,
    ...sections,
    categoryCount: header.kind === 'categorical' ? header.meta.categories.length : null,
    label: `The ${header.kind} result "${header.id}"`,
  });
  return { header, ...sections };
}

/**
 * Check one `setField` header: a key, a kind, the categories of a
 * categorical (null for a continuous), the dataset's cell count, and the
 * body's shape (codes for a categorical, floats for a continuous).
 */
function requireSetFieldHeader(header) {
  const { requestId, key, kind, categories, nObs, cells, values } = header;
  if (!isExactText(requestId)) throw new TypeError('A setField command requestId must be exact text');
  if (!isExactText(key, { whitespace: true })) throw new TypeError('A setField command key must be exact text');
  if (!VIEWER_FIELD_KINDS.includes(kind)) throw new TypeError('A setField command kind must be categorical or continuous');
  if (!Number.isSafeInteger(nObs) || nObs < 1 || nObs > 0xffffffff) throw new TypeError('A setField command nObs must be a cell count');
  if (cells !== null && (!isCount(cells) || cells < 1)) throw new TypeError('A setField command cells must be a count of at least one, or null');
  if (kind === 'categorical') {
    requireStringList(categories, 'A setField command\'s categories', { allowEmpty: false });
    if (!CODE_TYPES.includes(values)) throw new TypeError('A categorical setField command carries uint8, uint16 or uint32 codes');
  } else {
    if (categories !== null) throw new TypeError('A continuous setField command has no categories');
    if (!FLOAT_TYPES.includes(values)) throw new TypeError('A continuous setField command carries float32 or float64 values');
  }
}

/**
 * Build one binary command frame, as a host does: the header (exactly its
 * type's keys) and the cells, or `null` for a `setVisibility` of every cell
 * (`all: true`), and for a `setField` its values. The viewer never sends one;
 * the protocol's examples and tests are built with it.
 *
 * @param {Object} header
 * @param {Uint32Array|null} cells
 * @param {ArrayBufferView|null} [values] - A `setField`'s values
 * @returns {Uint8Array}
 */
export function encodeViewerBinaryCommand(header, cells, values = null) {
  if (!hasExactKeys(header, VIEWER_BINARY_COMMAND_HEADER_FIELDS[header?.type] ?? [null])) {
    throw new TypeError('A binary viewer command header must carry exactly the keys of its type');
  }
  if (header.type === 'setField') {
    requireSetFieldHeader(header);
    if ((cells === null) !== (header.cells === null) || (cells !== null && cells.length !== header.cells)) {
      throw new TypeError('A setField header counts the cells it names');
    }
    if (values === null || valueTypeOfArray(values) !== header.values) {
      throw new TypeError('A setField header names its values\' type');
    }
    requireSections({
      nObs: header.nObs,
      cells,
      values,
      categoryCount: header.kind === 'categorical' ? header.categories.length : null,
      label: `The setField command "${header.key}"`,
    });
    const body = [];
    if (cells !== null) body.push(littleEndianBytes(cells));
    body.push(littleEndianBytes(values));
    return encodeFrame(header, body, true);
  }
  if (values !== null) throw new TypeError('Only a setField command carries values');
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
 * least one (none, and nothing else, for `setVisibility` with `all: true`),
 * or for a `setField` its cells and values. The cells are a view of the
 * frame on a little-endian host when the body starts on a 4-byte boundary
 * (hosts pad the header so it does), else one copy. Whether every cell is one
 * of the dataset's is the command's to check, against the dataset it applies
 * to.
 *
 * @param {ArrayBuffer|Uint8Array} frame
 * @returns {{type: 'highlight', color: string, label: string|null, cells: Uint32Array}
 *   |{type: 'setVisibility', visible: boolean, cells: Uint32Array|null}
 *   |{type: 'setField', requestId: string, key: string, kind: string, categories: string[]|null,
 *     nObs: number, cells: Uint32Array|null, values: ArrayBufferView}}
 */
export function decodeViewerBinaryCommand(frame) {
  const { bytes, header, start } = readFrameHeader(frame, 'command');
  const fields = VIEWER_BINARY_COMMAND_HEADER_FIELDS[header?.type];
  if (fields === undefined || !Object.hasOwn(VIEWER_BINARY_COMMAND_HEADER_FIELDS, header.type)) {
    throw new TypeError('A binary command must be one this viewer reads as binary');
  }
  if (!hasExactKeys(header, fields)) {
    throw new TypeError(`A ${header.type} command header must carry exactly ${fields.join(', ')}`);
  }
  const bodyLength = bytes.byteLength - start;
  if (header.type === 'setField') {
    requireSetFieldHeader(header);
    const label = `The setField command "${header.key}"`;
    const { cells, values } = readSections(bytes, start, header, label);
    requireSections({
      nObs: header.nObs,
      cells,
      values,
      categoryCount: header.kind === 'categorical' ? header.categories.length : null,
      label,
    });
    const { type, requestId, key, kind, categories, nObs } = header;
    return { type, requestId, key, kind, categories, nObs, cells, values };
  }
  let every = false;
  if (header.type === 'highlight') {
    if (typeof header.color !== 'string') {
      throw new TypeError('A highlight command color must be text');
    }
    if (header.label !== null && !isExactText(header.label, { whitespace: true })) {
      throw new TypeError('A highlight command label must be exact text or null');
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
  const cells = readSection(bytes, start, bodyLength / 4, 'uint32');
  for (let index = 1; index < cells.length; index++) {
    if (cells[index] <= cells[index - 1]) {
      throw new TypeError(`A ${header.type} command must list its cells strictly ascending, each once`);
    }
  }
  return header.type === 'highlight'
    ? { type: 'highlight', color: header.color, label: header.label, cells }
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

/** One binary command example: its header, its cells (none for every cell), its values, its bytes. */
function binaryCommand(header, cells, values = null) {
  const frame = header.type === 'setField'
    ? encodeViewerBinaryCommand(
      header,
      cells === null ? null : Uint32Array.from(cells),
      VALUE_ARRAY_TYPES[header.values].from(values)
    )
    : encodeViewerBinaryCommand(header, cells === null ? null : Uint32Array.from(cells));
  return header.type === 'setField'
    ? { header, cells, values, hex: hex(frame) }
    : { header, cells: cells ?? [], hex: hex(frame) };
}

/** One result example: its header, cells (null: every cell), values (null: none), and bytes. */
/** The epoch of the examples' results. */
const EXAMPLE_EPOCH = '0123456789abcdef';

function resultEvent(result) {
  const { header, body } = encodeViewerResult({
    epoch: EXAMPLE_EPOCH,
    ...result,
    cells: result.cells === null ? null : Uint32Array.from(result.cells),
    values: result.values === null ? null : VALUE_ARRAY_TYPES[result.valueType].from(result.values),
  });
  return {
    header,
    cells: result.cells,
    values: result.values,
    hex: hex(encodeViewerBinaryFrame(header, body)),
  };
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
      {
        type: 'setGeneSet',
        requestId: 'r6',
        name: 'T cell markers',
        description: 'From the notebook',
        genes: ['CD3E', 'CD3D', 'IL7R'],
      },
    ],
    binaryCommands: [
      binaryCommand({ type: 'highlight', color: '#e41a1c', label: null }, [0, 2, 7]),
      // Past 2^31: a cell index is a uint32, every bit of it.
      binaryCommand({ type: 'highlight', color: '#00FF7f', label: 'Cycling cells' }, [5, 2147483648, 4294967295]),
      binaryCommand({ type: 'setVisibility', visible: false, all: false }, [1, 3]),
      binaryCommand({ type: 'setVisibility', visible: true, all: true }, null),
      // A categorical column of every cell: code 255 is "no category".
      binaryCommand({
        type: 'setField', requestId: 'r7', key: 'leiden', kind: 'categorical', categories: ['0', '1', '2'],
        nObs: 5, cells: null, values: 'uint8',
      }, null, [0, 2, 1, 255, 0]),
      // A continuous column of two cells of ten.
      binaryCommand({
        type: 'setField', requestId: 'r8', key: 'score', kind: 'continuous', categories: null,
        nObs: 10, cells: 2, values: 'float32',
      }, [3, 8], [0.5, -1.25]),
    ],
    events: [
      { type: 'hover', cell: 3, position: { x: 0.5, y: -1, z: 0 } },
      { type: 'hover', cell: null, position: null },
      { type: 'click', cell: 3, button: 0, shift: false, ctrl: true },
      { type: 'ready', n_cells: 100, n_obs: 250, dimensions: 2 },
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
      { type: 'color_by', field: 'cell_type', source: 'obs', label: 'cell_type' },
      { type: 'color_by', field: 'ENSG00000198851', source: 'var', label: 'CD3E' },
      { type: 'color_by', field: null, source: null, label: null },
      { type: 'result_removed', epoch: EXAMPLE_EPOCH, revision: 9, kind: 'highlight', id: 'highlight_2' },
      {
        type: 'results',
        epoch: EXAMPLE_EPOCH,
        dataset: 'example',
        revision: 8,
        nObs: 10,
        items: [
          { kind: 'highlight', id: 'highlight_1', revision: 1 },
          { kind: 'categorical', id: 'user_cat_1', revision: 2 },
          { kind: 'continuous', id: 'user_obs_value_1', revision: 3 },
          { kind: 'geneSet', id: 'gene_set_1', revision: 4 },
          { kind: 'visibility', id: 'visible', revision: 5 },
          { kind: 'subset', id: 'open', revision: 6 },
        ],
      },
      // The person opened another dataset in the viewer: a new epoch that
      // describes none of the host's.
      { type: 'results', epoch: 'fedcba9876543210', dataset: null, revision: 0, nObs: 2700, items: [] },
    ],
    binaryEvents: [
      { header: { type: 'selection', source: 'lasso' }, cells: [0, 2, 7], hex: hex(selection) },
      { header: { type: 'session_bundle', requestId: 'r3' }, bodyText: 'CELLUCID_SESSION\n', hex: hex(bundle) },
      resultEvent({
        requestId: null, revision: 1, kind: 'highlight', id: 'highlight_1', nObs: 10,
        meta: { label: 'Lasso selection (3 cells)', tool: 'lasso', pageId: 'page_1', pageName: 'Page 1', color: '#e41a1c', enabled: true },
        cells: [0, 2, 7], values: null,
      }),
      // A categorical over the open cells of a subsample: code 255 is "no category".
      resultEvent({
        requestId: null, revision: 2, kind: 'categorical', id: 'user_cat_1', nObs: 10,
        meta: { key: 'annotation', categories: ['B cell', 'T cell'], origin: 'user' },
        cells: [0, 3, 4, 9], values: [1, 0, 255, 1], valueType: 'uint8',
      }),
      resultEvent({
        requestId: null, revision: 3, kind: 'continuous', id: 'user_obs_value_1', nObs: 3,
        meta: { key: 'T cell markers score', origin: 'analysis' },
        cells: null, values: [0.25, -1, 3.5], valueType: 'float32',
      }),
      resultEvent({
        requestId: 'r6', revision: 4, kind: 'geneSet', id: 'gene_set_1', nObs: 10,
        // Genes by identifier (a CELLxGENE var index), with the symbols shown.
        meta: {
          name: 'T cell markers', description: 'From the notebook',
          genes: ['ENSG00000198851', 'ENSG00000167286', 'ENSG00000168685'], symbols: ['CD3E', 'CD3D', 'IL7R'],
          origin: 'notebook',
        },
        cells: [], values: null,
      }),
      resultEvent({
        requestId: null, revision: 5, kind: 'visibility', id: 'visible', nObs: 10,
        meta: {}, cells: [1, 2, 3], values: null,
      }),
      resultEvent({
        requestId: null, revision: 6, kind: 'subset', id: 'open', nObs: 10,
        meta: { digest: '0123456789abcdef' }, cells: [0, 3, 4, 9], values: null,
      }),
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
    results: {
      kinds: Object.fromEntries(Object.entries(VIEWER_RESULT_META_FIELDS).map(([kind, keys]) => [kind, [...keys]])),
      highlightTools: [...VIEWER_HIGHLIGHT_TOOLS],
      origins: [...VIEWER_RESULT_ORIGINS],
      fieldKinds: [...VIEWER_FIELD_KINDS],
      valueTypes: { ...VIEWER_VALUE_TYPES },
      epochPattern: VIEWER_RESULT_EPOCH_PATTERN,
      body: 'cells: header.cells little-endian uint32 original positions, strictly ascending (none when null); ' +
        'values: header.values, one per named cell, or one per cell of the dataset when cells is null; ' +
        'a code type\'s largest value is no category, NaN is no value',
    },
    dataMappingOrigins: [...VIEWER_DATA_MAPPING_ORIGINS],
    commandErrorReasonLimit: VIEWER_COMMAND_ERROR_REASON_LIMIT,
    examples: examples(),
  };
}

/** `tests/fixtures/viewer-protocol.json`, byte for byte. */
export function viewerProtocolJson() {
  return `${JSON.stringify(viewerProtocolDocumentFixture(), null, 2)}\n`;
}
