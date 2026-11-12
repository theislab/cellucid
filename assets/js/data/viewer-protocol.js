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
 *   exactly as `VIEWER_COMMAND_FIELDS` names them; an `action` whose
 *   parameters hold typed arrays (cells, a column's values) is a **binary
 *   frame** (`VIEWER_BINARY_COMMAND_HEADER_FIELDS`, `decodeViewerBinaryCommand`);
 * - **events** (viewer → host): text frames, keys exactly as
 *   `VIEWER_EVENT_FIELDS` names them; a selection, a result, an action's
 *   answer and a session bundle are **binary frames**
 *   (`VIEWER_BINARY_EVENT_HEADER_FIELDS`).
 *
 * **Actions.** Everything a host changes or reads in the viewer is an action
 * of the catalog (`app/actions/`; the catalog document both packages
 * generate their methods from is `tests/fixtures/action-catalog.json`): one
 * `action` command names it (`action`, its dotted type) with its parameters,
 * and the viewer answers it with one `action_result` (its outcome, a read's
 * result, and the history step it made, or null with why a change made none:
 * `unrecorded`, `VIEWER_ACTION_UNRECORDED`) or one `command_error`
 * carrying the same `requestId`. A host action takes the path a person's
 * control takes: one step of the history, labeled as the host's, undone like
 * any other. Undo, redo and jumps are actions of the catalog too, and so is
 * every other history action (`history.*`).
 *
 * **The history.** An action may belong to a host's **turn** (`turn`, its id,
 * and `turnLabel`, what it was asked to do; both null otherwise): every step
 * of one turn is undone together in the State panel, as an agent's turn is.
 * Whenever the history changes (a step, a move, an edit, a tracker, a loaded
 * session) the viewer sends `history_changed`, saying what kind of change it
 * was and where the history now stands, so a host keeps a current account of
 * it without asking; a host reads the history itself with the history's read
 * actions. A host pushes a session file into the viewer with `load_session`
 * (a binary frame, the file as its body), answered by `session_loaded` (the
 * tracker shown and its head) or a `command_error`; the file's trackers are
 * added beside the person's own.
 *
 * A binary frame, either way, is a little-endian uint32 header length, that
 * many bytes of UTF-8 JSON header, then the body (`encodeViewerBinaryFrame`).
 * A body of cells is little-endian uint32 cell indices: a million cells are
 * 4 MB read in place, where the same cells as JSON text were 7 MB to build
 * and parse. A binary `action`'s header lists each typed array of its
 * parameters (`arrays`: where it goes in `params`, its type and length) and
 * its body holds them in that order (`encodeViewerAction`).
 *
 * **Cells are original positions.** Every cell either side names -- in a
 * selection, a hover, a click, a result, an action's parameters -- is its
 * row in the dataset's `obs` (0-based), whether the viewer opened every cell
 * or a subsample of them (`data/cell-identity.js`). `nObs` in a result is the
 * dataset's whole cell count, so each side checks it names the same dataset.
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
 * values take NaN for "no value".
 *
 * **Agents.** A host may carry an agent's tool calls to the viewer: an agent
 * app on the same computer (Claude Code, Claude Desktop, Cursor) driving the
 * viewer through the host package's local MCP server (`cellucid mcp`). The
 * viewer runs them exactly as it runs a connector agent's calls
 * (`app/agent/bridge/agent-calls.js`): as the agent (`agent`, the app's name)
 * through a connection of kind `local` (`connection`: `{id, client}`, the
 * MCP session and the app's own name), so the person's permissions decide,
 * a question is asked in the viewer's confirm card, the steps are one turn
 * the person can Stop and undo. `agent_list` asks for the tools as that
 * connection may use them, answered by `agent_tools` (binary: the MCP tools
 * as UTF-8 JSON); `agent_call` runs one, answered by exactly one
 * `agent_result` (binary: the MCP tool result as UTF-8 JSON, an error
 * included); while the person is asked about a call the viewer sends
 * `agent_asking` (the card's question in one sentence, `message`, and what
 * makes it cost, `detail`) and then `agent_answered`; `agent_answer`
 * answers that question from the agent's app (the person answered an MCP
 * elicitation there); `agent_cancel` stops a call the app gave up on.
 * The tool list never changes with the person's settings (the agent is told
 * them after its results), so no event says it changed.
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

import { HOST_LITTLE_ENDIAN as HOST_IS_LITTLE_ENDIAN } from '../formats/io/byte-order.js';
import { formatCountOf } from '../utils/format-units.js';
import { allocateTypedArray } from './sparse-column-index.js';
import { HEX_COLOR, isHexColor } from '../utils/hex-color.js';
import { hexOfByteArray } from '../utils/byte-text.js';
import { upperFirst } from '../utils/text-case.js';

/** The document's version: a reader of `viewer-protocol.json` checks it. */
export const VIEWER_PROTOCOL_SCHEMA = 5;

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
 * What opened a viewer, as its `GET /_cellucid/info` names it (`runtime`),
 * and the one place the viewer's words for it come from:
 *
 * - `name`: what the person reads in a sentence ("the notebook", "the
 *   `cellucid serve` command"), lowercase, starting with "the"
 *   (`viewerHostSentenceName` capitalizes it at the start of a sentence);
 * - `label`: its short name ("Jupyter", "cellucid serve"), shown in the
 *   Dataset box and the dataset list ("R data");
 * - `language`: the language its steps in the history are labeled with
 *   (`python`, `r`);
 * - `reopen`: one sentence that says how to open the viewer again.
 *
 * `jupyter`: a Python notebook kernel (`show_anndata()`, `cellucid.Widget`,
 * an `AnnDataViewer` or `serve_anndata()` in a notebook); `python`: a Python
 * script or session outside a notebook (`AnnDataViewer`, `serve_anndata()`);
 * `cellucid-serve`: the `cellucid serve` command; `cellucid-mcp`: `cellucid
 * mcp --open`, an agent app's local MCP server; `r`: an R session
 * (`cellucid_view()`, `cellucid_serve()`, in a notebook too); `r-mcp`: R's
 * `cellucid_mcp(open = …)`, an agent app's local MCP server.
 */
export const VIEWER_HOST_RUNTIMES = Object.freeze({
  jupyter: Object.freeze({
    name: 'the notebook', label: 'Jupyter', language: 'python',
    reopen: 'Run the notebook cell that opened it again.',
  }),
  python: Object.freeze({
    name: 'the Python session', label: 'Python', language: 'python',
    reopen: 'Open it again from Python.',
  }),
  'cellucid-serve': Object.freeze({
    name: 'the cellucid serve command', label: 'cellucid serve', language: 'python',
    reopen: 'Run cellucid serve again.',
  }),
  'cellucid-mcp': Object.freeze({
    name: 'the agent app\'s cellucid mcp server', label: 'cellucid mcp', language: 'python',
    reopen: 'Restart the cellucid mcp server in the agent app.',
  }),
  r: Object.freeze({
    name: 'the R session', label: 'R', language: 'r',
    reopen: 'Run cellucid_view() or cellucid_serve() again.',
  }),
  'r-mcp': Object.freeze({
    name: 'the agent app\'s cellucid_mcp() server', label: 'cellucid_mcp()', language: 'r',
    reopen: 'Restart the cellucid_mcp() server in the agent app.',
  }),
});

/** The viewer's words for its host before the host said what it is. */
export const VIEWER_HOST_UNKNOWN = Object.freeze({
  name: 'the program serving this viewer', label: null, language: null,
  reopen: 'Open it again from where it was opened.',
});

/**
 * The words for the host `runtime` names (a key of `VIEWER_HOST_RUNTIMES`),
 * or the neutral ones for null.
 *
 * @param {string|null} runtime
 * @returns {{name: string, label: string|null, language: 'python'|'r'|null, reopen: string}}
 */
export function viewerHostWords(runtime) {
  if (runtime === null) return VIEWER_HOST_UNKNOWN;
  if (!Object.hasOwn(VIEWER_HOST_RUNTIMES, runtime)) {
    throw new TypeError(`A viewer host runtime is one of ${Object.keys(VIEWER_HOST_RUNTIMES).join(', ')}`);
  }
  return VIEWER_HOST_RUNTIMES[runtime];
}

/** The host's `name` at the start of a sentence ("The notebook"). */
export function viewerHostSentenceName(runtime) {
  const { name } = viewerHostWords(runtime);
  return upperFirst(name);
}

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
 * `action`: apply (or read) the catalog's action `action` (its dotted type,
 * `color.by`) with `params`, a JSON object the action's parameter schema
 * checks, as part of the host's turn `turn` (its id) labeled `turnLabel`, or
 * of none (both null); answered by an `action_result` or a `command_error`
 * with the same `requestId`. `requestSessionBundle`: the history as a
 * `.cellucid-session` file (format 4), answered by a `session_bundle` or a
 * `command_error`. `freeze`: the host stopped; keep the last complete view.
 */
export const VIEWER_COMMAND_FIELDS = Object.freeze({
  ping: Object.freeze(['type', 'requestId']),
  debug_snapshot: Object.freeze(['type', 'requestId']),
  requestSessionBundle: Object.freeze(['type', 'requestId']),
  freeze: Object.freeze(['type']),
  action: Object.freeze(['type', 'requestId', 'action', 'params', 'turn', 'turnLabel']),
  agent_list: Object.freeze(['type', 'requestId', 'connection']),
  agent_call: Object.freeze(['type', 'requestId', 'tool', 'args', 'agent', 'connection']),
  agent_cancel: Object.freeze(['type', 'requestId']),
  agent_answer: Object.freeze(['type', 'requestId', 'allowed']),
});

/**
 * The keys of an agent command's `connection`: `id`, the local connection
 * (one MCP session of one app: letters, digits, `_` and `-`, at most 64),
 * which the person's "allow for this connection" keys on; `client`, the
 * app's own name (`clientInfo.name`), or null.
 */
export const VIEWER_AGENT_CONNECTION_FIELDS = Object.freeze(['id', 'client']);
export const VIEWER_AGENT_CONNECTION_ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$';
const AGENT_CONNECTION_ID = new RegExp(VIEWER_AGENT_CONNECTION_ID_PATTERN);

/**
 * Every command a host sends as a binary frame, with the exact keys of its
 * header. `action`: an action whose parameters hold typed arrays (an
 * `x-cells` list of original positions as uint32, an `x-values` column as
 * any value type); `params` is the JSON rest of its parameters and `arrays`
 * lists each array in body order: `{path, type, length}`, `path` the keys
 * (and list indices) leading to it in `params`, its last key one `params`
 * does not hold (the array fills it). The body is each array's elements,
 * little-endian, one after another. `load_session`: a `.cellucid-session`
 * file (format 4) to load into the viewer's history, beside the person's own
 * trackers; `name` is the file's name (a loaded tracker names the file it came
 * from) and the body is the file, answered by a `session_loaded` or a
 * `command_error` with the same `requestId`.
 */
export const VIEWER_BINARY_COMMAND_HEADER_FIELDS = Object.freeze({
  action: Object.freeze(['type', 'requestId', 'action', 'params', 'turn', 'turnLabel', 'arrays']),
  load_session: Object.freeze(['type', 'requestId', 'name']),
});

/** The keys of one entry of a binary `action`'s `arrays`. */
export const VIEWER_ACTION_ARRAY_FIELDS = Object.freeze(['path', 'type', 'length']);

/**
 * Every event the viewer sends as a text frame, with its exact keys.
 * `ready`: the cells open (`n_cells`) and in the dataset (`n_obs`; more when
 * a subsample is open). `command_error`: a command the viewer did not carry
 * out, the `requestId` it named (null for one that names none) and why
 * (`reason`, one sentence a person can act on). `data_mapping`: the data
 * mapping the viewer shows, sent when a dataset opens and whenever it
 * changes, and why it is what it is (`origin`; `notebook` for a host's
 * `mapping.set`). `color_by`: the field the viewer colors by now
 * (`field` null: none), from `obs` or `var` (a gene, by its identifier: the
 * var index), and, for a gene whose shown name differs from its identifier
 * (the data mapping names the genes by a var column), that name (`symbol`;
 * null otherwise); for a gene read for a sample of the open cells (a large
 * dataset stored cell by cell: `data/anndata/subsample-plan.js`, `genes`),
 * how many of them it is read for, the first ones in their order
 * (`cells_read`; null when it is read for every open cell, and for an obs
 * field), sent again when that grows. `result_removed`: a
 * result of `epoch` is gone. `results`: every result the viewer holds in
 * `epoch` at `revision`, each `{kind, id, revision}`, sent after every result
 * of a snapshot, and the host dataset they describe (`dataset`; null: the
 * viewer shows another dataset, and `items` is empty). `history_changed`: the
 * history changed (`kind`, one of `VIEWER_HISTORY_CHANGE_KINDS`), and where it
 * stands now: the tracker in use (`tracker`, its id), the step shown
 * (`head`), the step the change made or concerns (`step`; null when none),
 * and the active branch (`branch`, its id; null while the history names
 * none). `session_loaded`: the session file of `load_session` `requestId` is
 * loaded: the tracker now shown (`tracker`, `{id, name}`) and its step shown
 * (`head`).
 */
export const VIEWER_EVENT_FIELDS = Object.freeze({
  hover: Object.freeze(['type', 'cell', 'position']),
  click: Object.freeze(['type', 'cell', 'button', 'shift', 'ctrl']),
  ready: Object.freeze(['type', 'n_cells', 'n_obs', 'dimensions']),
  pong: Object.freeze(['type', 'requestId', 't']),
  debug_snapshot: Object.freeze([
    'type', 'requestId', 'ts', 'locationHref', 'origin', 'serverUrl', 'connected', 'userAgent',
  ]),
  command_error: Object.freeze(['type', 'command', 'requestId', 'reason']),
  data_mapping: Object.freeze(['type', 'origin', 'mapping']),
  color_by: Object.freeze(['type', 'field', 'source', 'symbol', 'cells_read']),
  result_removed: Object.freeze(['type', 'epoch', 'revision', 'kind', 'id']),
  results: Object.freeze(['type', 'epoch', 'dataset', 'revision', 'nObs', 'items']),
  history_changed: Object.freeze(['type', 'kind', 'tracker', 'head', 'step', 'branch']),
  session_loaded: Object.freeze(['type', 'requestId', 'tracker', 'head']),
  agent_asking: Object.freeze(['type', 'requestId', 'message', 'detail']),
  agent_answered: Object.freeze(['type', 'requestId', 'allowed']),
});

/**
 * What a `history_changed` says changed: a step was recorded (`step`), the
 * step shown moved (`moved`: undo, redo, a jump, another branch), the
 * history's structure was edited (`edited`: a rename, a note, a bookmark, a
 * delete, a restore, …), a tracker was started, used, renamed or removed
 * (`tracker`), or a session file was loaded (`loaded`).
 */
export const VIEWER_HISTORY_CHANGE_KINDS = Object.freeze(['step', 'moved', 'edited', 'tracker', 'loaded']);

/** The keys of a `session_loaded`'s `tracker`. */
export const VIEWER_SESSION_LOADED_TRACKER_FIELDS = Object.freeze(['id', 'name']);

/**
 * Every event the viewer sends as a binary frame, with the exact keys of its
 * header. `selection`: the body is the selected cells (original positions),
 * little-endian uint32, strictly ascending, at least one. `session_bundle`:
 * the body is the `.cellucid-session` file the host asked for with
 * `requestSessionBundle`. `result`: one result (`encodeViewerResult`).
 * `action_result`: the answer to the `action` command of `requestId`: the
 * body is its outcome as UTF-8 JSON (`null` when the action did nothing to
 * report; a read's result otherwise), `step` the history step it made,
 * `{id, label}`, or null, and `unrecorded` why a change made no step (a key
 * of `VIEWER_ACTION_UNRECORDED`), null when it made one and for an action
 * that is no change (a read, a move of the history, an act outside the
 * state). The outcome travels in a body because a read's result (a picture
 * of a view, the values of many cells) is as large as it asks for.
 */
export const VIEWER_BINARY_EVENT_HEADER_FIELDS = Object.freeze({
  selection: Object.freeze(['type', 'source']),
  session_bundle: Object.freeze(['type', 'requestId']),
  result: Object.freeze(['type', 'epoch', 'revision', 'kind', 'id', 'nObs', 'meta', 'cells', 'values']),
  action_result: Object.freeze(['type', 'requestId', 'step', 'unrecorded']),
  agent_tools: Object.freeze(['type', 'requestId']),
  agent_result: Object.freeze(['type', 'requestId']),
});

/** The keys of an `action_result`'s `step`. */
export const VIEWER_ACTION_STEP_FIELDS = Object.freeze(['id', 'label']);

/**
 * Why a change made no step of the history (an `action_result`'s
 * `unrecorded`; the dispatcher's, `app/actions/dispatcher.js`), each with
 * the sentence a host says to its person after the call that asked
 * (`viewer.color_by(...): …`): it was so already (`unchanged`); it put back
 * what the step just before it changed, which is taken out (`retracted`);
 * the History settings leave this kind of change out (`off`); recording is
 * paused (`paused`); another tracker was shown meanwhile (`elsewhere`); the
 * dataset's history has not started (`no-history`). The one closed set:
 * an agent is told the same reasons (`agent/bridge/mcp-content.js`
 * `UNRECORDED_NOTES`), and cellucid-python and cellucid-r keep these
 * sentences (the fixture's `action.unrecorded`).
 */
export const VIEWER_ACTION_UNRECORDED = Object.freeze({
  unchanged: 'it changed nothing (it was so already), so no step was recorded.',
  retracted: 'it put back what the step just before it changed, so that step was taken out and no step was recorded.',
  off: 'done, but the History settings do not record this kind of change, so no step was recorded and Undo does not take it back.',
  paused: 'done, but the history\'s recording is paused, so no step was recorded and Undo does not take it back.',
  elsewhere: 'done, but another tracker of the history was shown meanwhile, so no step was recorded.',
  'no-history': 'done, but the dataset\'s history has not started yet, so no step was recorded.',
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
 *   clusters): `key`, `categories`, `colors`, `origin`. `colors`: one
 *   `#rrggbb` (lowercase) a category, in the categories' order -- the colors
 *   the field is shown in, in the view in focus (the color the person or an
 *   agent gave a category there, else its `palette`, else Cellucid's own by
 *   position: the rule a session's apply writes `uns['<key>_colors']` by),
 *   so a pull writes them. Values: category codes.
 * - `continuous`: a user-defined continuous field or a score: `key`,
 *   `origin`. Values: floats.
 * - `geneSet`: `name`, `description`, `genes` (by identifier: the var
 *   index, as every gene crossing the boundary), `symbols` (the name the
 *   viewer shows for each gene, in the same order, when the data mapping
 *   names the genes by a var column and a name differs from its identifier;
 *   null otherwise), `origin`. No cells (count 0), no values.
 * - `visibility`: the cells the filters leave visible (id `visible`); cells
 *   null when every cell is.
 * - `subset`: the cells the viewer opened (id `open`), with the open set's
 *   `digest` (`data/cell-identity.js`); cells null when every cell is.
 */
export const VIEWER_RESULT_META_FIELDS = Object.freeze({
  highlight: Object.freeze(['label', 'tool', 'pageId', 'pageName', 'color', 'enabled']),
  categorical: Object.freeze(['key', 'categories', 'colors', 'origin']),
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
 * (`markers`), or a host (`notebook`: pushed with its `field.push` or
 * `gene-set.save` action).
 */
export const VIEWER_RESULT_ORIGINS = Object.freeze(['analysis', 'markers', 'notebook', 'user']);

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

/**
 * Longest `command_error` reason the viewer sends: room for an action's
 * refusal that names what it expected ("There is no category … in …; its
 * categories are …").
 */
export const VIEWER_COMMAND_ERROR_REASON_LIMIT = 1000;

/** Every event type, text and binary, sorted. */
export function viewerEventTypes() {
  return [...Object.keys(VIEWER_EVENT_FIELDS), ...Object.keys(VIEWER_BINARY_EVENT_HEADER_FIELDS)].sort();
}

/** Every command type, text and binary (an `action` is either), sorted. */
export function viewerCommandTypes() {
  return [...new Set([...Object.keys(VIEWER_COMMAND_FIELDS), ...Object.keys(VIEWER_BINARY_COMMAND_HEADER_FIELDS)])].sort();
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
  const text = new TextEncoder().encode(JSON.stringify(header));
  // Padding counts bytes, not characters: a header with non-ASCII text is
  // longer in UTF-8 than in characters.
  const pad = aligned ? (4 - (text.length % 4)) % 4 : 0;
  const headerBytes = pad === 0 ? text : Uint8Array.from([...text, ...new Array(pad).fill(0x20)]);
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
  const { epoch, revision, kind, id, nObs, meta, cells, values } = header;
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
      if (!isHexColor(meta.color) || typeof meta.enabled !== 'boolean') {
        throw new TypeError('A highlight result carries its page color and whether it is enabled');
      }
      if (cells === null || cells < 1 || values !== null) {
        throw new TypeError('A highlight result names its cells, at least one, and no values');
      }
      return header;
    case 'categorical':
      if (!isExactText(meta.key, { whitespace: true })) throw new TypeError('A categorical result names its key');
      requireStringList(meta.categories, 'A categorical result\'s categories', { allowEmpty: false });
      if (!Array.isArray(meta.colors) || meta.colors.length !== meta.categories.length
        || !meta.colors.every(color => typeof color === 'string' && HEX_COLOR.test(color))) {
        throw new TypeError('A categorical result carries one #rrggbb color (lowercase) for each of its categories');
      }
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
      if (meta.symbols !== null) {
        requireStringList(meta.symbols, 'A gene set result\'s symbols', { whitespace: true, unique: false });
        if (meta.symbols.length !== meta.genes.length) {
          throw new TypeError('A gene set result names a symbol for each of its genes, or none');
        }
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
 * @param {{epoch: string, revision: number, kind: string, id: string,
 *   nObs: number, meta: Object, cells: Uint32Array|null,
 *   values: Uint8Array|Uint16Array|Uint32Array|Float32Array|Float64Array|null}} result
 *   `cells`: original positions, ascending; null for every cell of the dataset
 * @returns {{header: Object, body: Uint8Array[]}}
 */
export function encodeViewerResult(result) {
  const { epoch, revision, kind, id, nObs, meta, cells, values } = result;
  if (cells !== null && !(cells instanceof Uint32Array)) {
    throw new TypeError('Result cells must be a Uint32Array of original positions or null');
  }
  const header = {
    type: 'result',
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

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** A dotted action type, as the catalog names one (`app/actions/catalog.js`). */
const ACTION_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;

/** Whether `value` is a dotted action type (`color.by`); its text is safe to show. */
export function isViewerActionType(value) {
  return typeof value === 'string' && ACTION_TYPE_PATTERN.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !ArrayBuffer.isView(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** A JSON value with finite numbers, plain objects and lists only. */
function requireJsonValue(value, label, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} holds a number JSON cannot carry`);
    return;
  }
  if (typeof value !== 'object' || ancestors.has(value) || (!Array.isArray(value) && !isPlainObject(value))) {
    throw new TypeError(`${label} must be JSON`);
  }
  ancestors.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) requireJsonValue(entry, label, ancestors);
  ancestors.delete(value);
}

/**
 * Check an `action` command's own fields (its parameters are the action's
 * schema's to check): a request id, a dotted action type, parameters that
 * are one JSON object (typed arrays already placed in it), and its turn:
 * `turn` (the turn's id, exact text) and `turnLabel` (what the turn was asked
 * to do, text), both set or both null.
 *
 * @param {{requestId: unknown, action: unknown, params: unknown, turn: unknown, turnLabel: unknown}} command
 */
export function requireViewerActionCommand(command) {
  if (!isExactText(command?.requestId)) throw new TypeError('An action command requestId must be exact text');
  if (!isViewerActionType(command.action)) {
    throw new TypeError('An action command names its action by its dotted type, such as "color.by"');
  }
  if (!isPlainObject(command.params)) throw new TypeError('An action command params must be one object');
  if ((command.turn === null) !== (command.turnLabel === null)) {
    throw new TypeError('An action command names its turn and the turn\'s label together, or neither');
  }
  if (command.turn !== null && !isExactText(command.turn)) throw new TypeError('An action command turn must be exact text or null');
  if (command.turnLabel !== null && !isExactText(command.turnLabel, { whitespace: true })) {
    throw new TypeError('An action command turnLabel must be text or null');
  }
  return command;
}

function requireAgentConnection(connection, label) {
  if (!hasExactKeys(connection, VIEWER_AGENT_CONNECTION_FIELDS)) {
    throw new TypeError(`${label} connection must be {id, client}`);
  }
  if (typeof connection.id !== 'string' || !AGENT_CONNECTION_ID.test(connection.id)) {
    throw new TypeError(`${label} connection id must be 1 to 64 letters, digits, "_" or "-"`);
  }
  if (connection.client !== null && !isExactText(connection.client, { whitespace: true })) {
    throw new TypeError(`${label} connection client must be the app's name, or null`);
  }
  return connection;
}

/**
 * Check an agent command (`agent_list`, `agent_call`, `agent_cancel`,
 * `agent_answer`) beyond its keys: its `requestId`, and the fields of its
 * type -- a connection `{id, client}`, a tool name, arguments that are one
 * JSON object, the agent's name, whether the person allowed it.
 *
 * @param {{type: string}} command
 */
export function requireViewerAgentCommand(command) {
  const label = `An ${command?.type} command`;
  if (!isExactText(command?.requestId)) throw new TypeError(`${label} requestId must be exact text`);
  switch (command.type) {
    case 'agent_list':
      requireAgentConnection(command.connection, label);
      return command;
    case 'agent_call':
      if (typeof command.tool !== 'string' || !/^[a-z][a-z0-9_]*$/.test(command.tool)) {
        throw new TypeError(`${label} names its tool as the tool list does, such as "color_by"`);
      }
      if (!isPlainObject(command.args)) throw new TypeError(`${label} args must be one object`);
      requireJsonValue(command.args, `${label} args`);
      if (!isExactText(command.agent, { whitespace: true })) {
        throw new TypeError(`${label} names its agent, exact text`);
      }
      requireAgentConnection(command.connection, label);
      return command;
    case 'agent_cancel':
      return command;
    case 'agent_answer':
      if (typeof command.allowed !== 'boolean') throw new TypeError(`${label} allowed must be true or false`);
      return command;
    default:
      throw new TypeError(`"${command.type}" is no agent command`);
  }
}

/**
 * The typed arrays of an action's parameters taken out: the JSON rest, and
 * each array with the path to it, in the order met. An array goes under an
 * object's key (a parameter, or a key of an object inside one), never
 * directly in a list.
 *
 * @param {object} params
 * @returns {{params: object, arrays: Array<{path: Array<string|number>, type: string, array: ArrayBufferView}>}}
 */
function splitActionParams(params) {
  const arrays = [];
  const visit = (node, path, inList) => {
    if (ArrayBuffer.isView(node)) {
      if (inList) throw new TypeError(`An action parameter list holds a typed array at ${path.join('.')}; put it under a key`);
      arrays.push({ path, type: valueTypeOfArray(node), array: node });
      return undefined;
    }
    if (Array.isArray(node)) return node.map((item, index) => visit(item, [...path, index], true));
    if (isPlainObject(node)) {
      const out = {};
      for (const [key, child] of Object.entries(node)) {
        const kept = visit(child, [...path, key], false);
        if (kept !== undefined) Object.defineProperty(out, key, { value: kept, enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return node;
  };
  const rest = visit(params, [], false);
  requireJsonValue(rest, 'An action command params');
  return { params: rest, arrays };
}

/**
 * One `action` command as a host sends it: a JSON text frame when its
 * parameters hold no typed array, else a binary frame whose header lists the
 * arrays (`VIEWER_BINARY_COMMAND_HEADER_FIELDS.action`) and whose body holds
 * them, the header padded to a multiple of 4 bytes. The viewer never sends
 * one; the protocol's examples and tests are built with it, and the packages'
 * encoders must make the same bytes.
 *
 * @param {{requestId: string, action: string, params: object, turn?: string|null, turnLabel?: string|null}} command
 * @returns {string|Uint8Array}
 */
export function encodeViewerAction({ requestId, action, params, turn = null, turnLabel = null }) {
  requireViewerActionCommand({ requestId, action, params, turn, turnLabel });
  const split = splitActionParams(params);
  if (split.arrays.length === 0) {
    return JSON.stringify({ type: 'action', requestId, action, params: split.params, turn, turnLabel });
  }
  const header = {
    type: 'action',
    requestId,
    action,
    params: split.params,
    turn,
    turnLabel,
    arrays: split.arrays.map(({ path, type, array }) => ({ path, type, length: array.length })),
  };
  return encodeFrame(header, split.arrays.map(({ array }) => littleEndianBytes(array)), true);
}

/**
 * One `load_session` command as a host sends it: a binary frame whose header
 * names the request and the file, padded to a multiple of 4 bytes, and whose
 * body is the `.cellucid-session` file. The viewer never sends one; the
 * protocol's examples and tests are built with it, and the packages' encoders
 * must make the same bytes.
 *
 * @param {{requestId: string, name: string, file: Uint8Array}} command
 * @returns {Uint8Array}
 */
export function encodeViewerLoadSession({ requestId, name, file }) {
  requireViewerLoadSession({ requestId, name, file });
  return encodeFrame({ type: 'load_session', requestId, name }, file, true);
}

/**
 * Check a `load_session` command: a request id, the file's name (text, no
 * path), and a body that is a non-empty file.
 *
 * @param {{requestId: unknown, name: unknown, file: unknown}} command
 */
export function requireViewerLoadSession(command) {
  if (!isExactText(command?.requestId)) throw new TypeError('A load_session command requestId must be exact text');
  if (!isExactText(command.name, { whitespace: true }) || /[\\/]/.test(command.name)) {
    throw new TypeError('A load_session command names the file by its name (text without a folder)');
  }
  if (!(command.file instanceof Uint8Array) || command.file.byteLength === 0) {
    throw new TypeError('A load_session command carries the session file as its body');
  }
  return command;
}

/**
 * Check a `history_changed` event before the viewer sends it.
 *
 * @param {{type: string, kind: unknown, tracker: unknown, head: unknown, step: unknown, branch: unknown}} event
 */
export function requireViewerHistoryChanged(event) {
  if (!hasExactKeys(event, VIEWER_EVENT_FIELDS.history_changed) || event.type !== 'history_changed') {
    throw new TypeError(`A history_changed event carries exactly ${VIEWER_EVENT_FIELDS.history_changed.join(', ')}`);
  }
  if (!VIEWER_HISTORY_CHANGE_KINDS.includes(event.kind)) {
    throw new TypeError(`A history_changed kind is one of ${VIEWER_HISTORY_CHANGE_KINDS.join(', ')}`);
  }
  for (const key of ['tracker', 'head']) {
    if (!isExactText(event[key])) throw new TypeError(`A history_changed ${key} is an id`);
  }
  for (const key of ['step', 'branch']) {
    if (event[key] !== null && !isExactText(event[key])) throw new TypeError(`A history_changed ${key} is an id or null`);
  }
  return event;
}

function requireArrayPath(path, label) {
  if (!Array.isArray(path) || path.length === 0) throw new TypeError(`${label} path must name where it goes`);
  path.forEach((key, index) => {
    const last = index === path.length - 1;
    if (typeof key === 'string' ? key.length === 0 : !(Number.isSafeInteger(key) && key >= 0 && !last)) {
      throw new TypeError(`${label} path must be keys and list indices ending in a key`);
    }
  });
}

/** Put `array` at `path` of `params`: every step but the last exists, the last key does not. */
function placeArray(params, path, array, label) {
  let node = params;
  for (const key of path.slice(0, -1)) {
    const next = typeof key === 'number'
      ? (Array.isArray(node) && key < node.length ? node[key] : undefined)
      : (isPlainObject(node) && Object.hasOwn(node, key) ? node[key] : undefined);
    if (next === undefined || next === null || typeof next !== 'object') {
      throw new TypeError(`${label} path ${JSON.stringify(path)} leads nowhere in params`);
    }
    node = next;
  }
  const key = path[path.length - 1];
  if (!isPlainObject(node) || Object.hasOwn(node, key)) {
    throw new TypeError(`${label} path ${JSON.stringify(path)} must name a key params does not hold`);
  }
  Object.defineProperty(node, key, { value: array, enumerable: true, writable: true, configurable: true });
}

/**
 * Read one binary command frame from the host, checked as strictly as the
 * hosts check the viewer's binary events: the header length inside the
 * frame, the header exactly its type's keys, every array's path, type and
 * length, and a body of exactly those arrays. Each array is a view of the
 * frame on a little-endian host when it starts on a boundary of its element
 * size, else one copy, and goes into `params` at its path. Whether the
 * parameters fit the action is the action's schema to say (`x-cells` takes a
 * Uint32Array, `x-values` any numeric array), and whether its cells are the
 * dataset's is the action's to check.
 *
 * @param {ArrayBuffer|Uint8Array} frame
 * @returns {{type: 'action', requestId: string, action: string, params: object}}
 */
export function decodeViewerBinaryCommand(frame) {
  const { bytes, header, start } = readFrameHeader(frame, 'command');
  const fields = isPlainObject(header) && Object.hasOwn(VIEWER_BINARY_COMMAND_HEADER_FIELDS, header.type)
    ? VIEWER_BINARY_COMMAND_HEADER_FIELDS[header.type]
    : undefined;
  if (fields === undefined) throw new TypeError('A binary command must be one this viewer reads as binary');
  if (!hasExactKeys(header, fields)) {
    throw new TypeError(`A ${header.type} command header must carry exactly ${fields.join(', ')}`);
  }
  if (header.type === 'load_session') {
    const command = { type: 'load_session', requestId: header.requestId, name: header.name, file: bytes.subarray(start) };
    requireViewerLoadSession(command);
    return command;
  }
  requireViewerActionCommand(header);
  requireJsonValue(header.params, 'An action command params');
  if (!Array.isArray(header.arrays) || header.arrays.length === 0) {
    throw new TypeError('A binary action command lists the arrays its body holds');
  }
  let expected = 0;
  header.arrays.forEach((entry, index) => {
    const label = `The action command's array ${index}`;
    if (!hasExactKeys(entry, VIEWER_ACTION_ARRAY_FIELDS)) {
      throw new TypeError(`${label} must carry exactly ${VIEWER_ACTION_ARRAY_FIELDS.join(', ')}`);
    }
    requireArrayPath(entry.path, label);
    if (!Object.hasOwn(VIEWER_VALUE_TYPES, entry.type)) {
      throw new TypeError(`${label} type must be one of ${Object.keys(VIEWER_VALUE_TYPES).join(', ')}`);
    }
    if (!isCount(entry.length)) throw new TypeError(`${label} length must be a count`);
    expected += entry.length * VIEWER_VALUE_TYPES[entry.type];
  });
  if (bytes.byteLength - start !== expected) {
    throw new TypeError(`A binary action command body must be ${formatCountOf(expected, 'byte')} for its arrays, not ${bytes.byteLength - start}`);
  }
  const params = header.params;
  let at = start;
  header.arrays.forEach((entry, index) => {
    placeArray(params, entry.path, readSection(bytes, at, entry.length, entry.type), `The action command's array ${index}`);
    at += entry.length * VIEWER_VALUE_TYPES[entry.type];
  });
  return {
    type: 'action', requestId: header.requestId, action: header.action, params, turn: header.turn, turnLabel: header.turnLabel,
  };
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

/**
 * One binary `action` example: its header (with the arrays it lists), each
 * array's elements, and its bytes. `arrays` gives `[path, type, elements]`.
 */
function binaryAction(requestId, action, params, arrays, turn = null, turnLabel = null) {
  const full = structuredClone(params);
  for (const [path, type, elements] of arrays) {
    let node = full;
    for (const key of path.slice(0, -1)) node = node[key];
    node[path[path.length - 1]] = VALUE_ARRAY_TYPES[type].from(elements);
  }
  const frame = encodeViewerAction({ requestId, action, params: full, turn, turnLabel });
  const header = {
    type: 'action', requestId, action, params, turn, turnLabel,
    arrays: arrays.map(([path, type, elements]) => ({ path, type, length: elements.length })),
  };
  return { header, arrays: arrays.map(([path, type, elements]) => ({ path, type, elements })), hex: hexOfByteArray(frame) };
}

/** One `load_session` example: its header, its body as text, and its bytes. */
function loadSessionCommand(requestId, name, bodyText) {
  const file = new TextEncoder().encode(bodyText);
  return { header: { type: 'load_session', requestId, name }, bodyText, hex: hexOfByteArray(encodeViewerLoadSession({ requestId, name, file })) };
}

/** One `action_result` example: its header, its outcome, and its bytes. */
function actionResultEvent(requestId, outcome, step, unrecorded = null) {
  const header = { type: 'action_result', requestId, step, unrecorded };
  return { header, outcome, hex: hexOfByteArray(encodeViewerBinaryFrame(header, new TextEncoder().encode(JSON.stringify(outcome)))) };
}

/** One binary agent event example (`agent_tools`, `agent_result`): its header, its JSON body, and its bytes. */
function agentJsonEvent(type, requestId, body) {
  const header = { type, requestId };
  return { header, body, hex: hexOfByteArray(encodeViewerBinaryFrame(header, new TextEncoder().encode(JSON.stringify(body)))) };
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
    hex: hexOfByteArray(encodeViewerBinaryFrame(header, body)),
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
      { type: 'freeze' },
      { type: 'action', requestId: 'r4', action: 'color.by', params: { field: { source: 'obs', key: 'cell_type' } }, turn: null, turnLabel: null },
      // A read: answered by its result, and no step.
      { type: 'action', requestId: 'r5', action: 'history.get', params: {}, turn: null, turnLabel: null },
      // Part of a notebook turn (`with viewer.turn("QC")`): its steps undo together.
      { type: 'action', requestId: 'r6', action: 'gene-set.save', params: { name: 'T cell markers', description: 'From the notebook', genes: ['CD3E', 'CD3D', 'IL7R'] }, turn: 'python-turn-1', turnLabel: 'Marker genes' },
      // Cells as a JSON list: a few cells need no binary frame.
      { type: 'action', requestId: 'r7', action: 'cells.visibility.set', params: { cells: null, visible: true }, turn: null, turnLabel: null },
      // A history action, by its type, as every other.
      { type: 'action', requestId: 'r14', action: 'history.undo', params: {}, turn: null, turnLabel: null },
      // An agent app on this computer, through `cellucid mcp`: its tools, a call, a stop, an answer it got from the person.
      { type: 'agent_list', requestId: 'a1', connection: { id: 'local-3f9c2a7d', client: 'claude-code' } },
      { type: 'agent_call', requestId: 'a2', tool: 'color_by', args: { field: { source: 'obs', key: 'cell_type' } }, agent: 'Claude Code', connection: { id: 'local-3f9c2a7d', client: 'claude-code' } },
      { type: 'agent_call', requestId: 'a3', tool: 'history_get', args: {}, agent: 'Cursor', connection: { id: 'local-77e0b1c4', client: null } },
      { type: 'agent_cancel', requestId: 'a3' },
      { type: 'agent_answer', requestId: 'a4', allowed: false },
    ],
    binaryCommands: [
      binaryAction('r8', 'highlight.cells', { color: '#e41a1c' }, [[['cells'], 'uint32', [0, 2, 7]]]),
      // Past 2^31: a cell index is a uint32, every bit of it; any order.
      binaryAction('r9', 'highlight.cells', { label: 'Cycling cells', page: 'Notebook' }, [[['cells'], 'uint32', [4294967295, 5, 2147483648]]]),
      binaryAction('r10', 'cells.visibility.set', { visible: false }, [[['cells'], 'uint32', [1, 3]]], 'python-turn-1', 'Hide the doublets'),
      // A categorical column of every cell (cells null): code 255 is "no category".
      binaryAction('r11', 'field.push', { key: 'leiden', kind: 'categorical', categories: ['0', '1', '2'], n_obs: 5, cells: null }, [
        [['values'], 'uint8', [0, 2, 1, 255, 0]],
      ]),
      // A continuous column of two cells of ten: cells, then values.
      binaryAction('r12', 'field.push', { key: 'score', kind: 'continuous', categories: null, n_obs: 10 }, [
        [['cells'], 'uint32', [3, 8]],
        [['values'], 'float32', [0.5, -1.25]],
      ]),
      // An array inside an object of the parameters (the path names it), and an empty one.
      binaryAction('r13', 'example.nested', { groups: [{ name: 'a' }, { name: 'b' }] }, [
        [['groups', 0, 'cells'], 'uint32', [1, 2]],
        [['groups', 1, 'cells'], 'uint32', []],
        [['weights'], 'float64', [0.25]],
      ]),
      // A session file pushed into the viewer (the body here stands for one).
      loadSessionCommand('r15', 'T cell analysis.cellucid-session', 'CELLUCID_SESSION/4\n'),
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
      { type: 'command_error', command: 'action', requestId: 'r4', reason: 'There is no field "cell_typ" in obs; did you mean cell_type?' },
      // A command that names no request (or a frame read no further than its type).
      { type: 'command_error', command: 'freeze', requestId: null, reason: 'The viewer has no dataset open.' },
      { type: 'data_mapping', origin: 'notebook', mapping: EXAMPLE_MAPPING },
      { type: 'color_by', field: 'cell_type', source: 'obs', symbol: null, cells_read: null },
      { type: 'color_by', field: 'CD3E', source: 'var', symbol: null, cells_read: null },
      { type: 'color_by', field: 'ENSG00000198851', source: 'var', symbol: 'CD3E', cells_read: null },
      // A gene read for the first 40,000 open cells only (a gene sample).
      { type: 'color_by', field: 'ENSG00000168484', source: 'var', symbol: 'SFTPC', cells_read: 40000 },
      { type: 'color_by', field: null, source: null, symbol: null, cells_read: null },
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
      // The history: a step recorded, a move, an edit, another tracker, a loaded session.
      { type: 'history_changed', kind: 'step', tracker: 't-0b7c6f0e-3c1a-4a52-9d1e-5f2b8c4a7e10', head: 's4', step: 's4', branch: 'b0' },
      { type: 'history_changed', kind: 'moved', tracker: 't-0b7c6f0e-3c1a-4a52-9d1e-5f2b8c4a7e10', head: 's2', step: null, branch: 'b0' },
      { type: 'history_changed', kind: 'edited', tracker: 't-0b7c6f0e-3c1a-4a52-9d1e-5f2b8c4a7e10', head: 's2', step: null, branch: 'b1' },
      { type: 'history_changed', kind: 'tracker', tracker: 't-5d0e1c2b-7a4f-4e8b-9c3d-2f1a0b9c8d7e', head: 's0', step: null, branch: null },
      { type: 'history_changed', kind: 'loaded', tracker: 't-5d0e1c2b-7a4f-4e8b-9c3d-2f1a0b9c8d7e', head: 's9', step: null, branch: 'b2' },
      { type: 'session_loaded', requestId: 'r15', tracker: { id: 't-5d0e1c2b-7a4f-4e8b-9c3d-2f1a0b9c8d7e', name: 'T cell analysis' }, head: 's9' },
      // The person is asked about an agent's call in the viewer (and answers there, or in the agent's app).
      { type: 'agent_asking', requestId: 'a4', message: 'Claude Code (local) asks to save a copy as a file. It writes a file on this computer.', detail: null },
      { type: 'agent_answered', requestId: 'a4', allowed: false },
    ],
    binaryEvents: [
      { header: { type: 'selection', source: 'lasso' }, cells: [0, 2, 7], hex: hexOfByteArray(selection) },
      { header: { type: 'session_bundle', requestId: 'r3' }, bodyText: 'CELLUCID_SESSION\n', hex: hexOfByteArray(bundle) },
      // A change: its outcome, and the step of the history it made.
      actionResultEvent('r4', null, { id: 's3', label: 'Colored by cell_type' }),
      actionResultEvent('r11', { name: 'leiden', kind: 'categorical', id: 'user_cat_1' }, { id: 's4', label: 'Added the categorical column leiden' }),
      // A read: its result, and no step.
      actionResultEvent('r5', { head: 's4', steps: [{ id: 's0', label: 'Opened Example' }], note: 'Ünïcode — kept as UTF-8' }, null),
      // A change that made no step, and why: the cells were colored by cell_type already.
      actionResultEvent('r16', { field: 'cell_type' }, null, 'unchanged'),
      // An agent's tools (the MCP tools, as its connection may use them), and a call's MCP result.
      agentJsonEvent('agent_tools', 'a1', [{
        name: 'color_by', title: 'Color by a field', description: 'Color the cells by a field.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { title: 'Color by a field', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      }]),
      agentJsonEvent('agent_result', 'a2', { content: [{ type: 'text', text: '{"step":{"id":"s5","label":"Colored by cell_type"}}' }], isError: false }),
      agentJsonEvent('agent_result', 'a4', { content: [{ type: 'text', text: 'The person declined: save a copy.' }], isError: true }),
      resultEvent({
        revision: 1, kind: 'highlight', id: 'highlight_1', nObs: 10,
        meta: { label: 'Lasso selection (3 cells)', tool: 'lasso', pageId: 'page_1', pageName: 'Page 1', color: '#e41a1c', enabled: true },
        cells: [0, 2, 7], values: null,
      }),
      // A categorical over the open cells of a subsample: code 255 is "no category".
      resultEvent({
        revision: 2, kind: 'categorical', id: 'user_cat_1', nObs: 10,
        meta: { key: 'annotation', categories: ['B cell', 'T cell'], colors: ['#ff9900', '#0077c8'], origin: 'user' },
        cells: [0, 3, 4, 9], values: [1, 0, 255, 1], valueType: 'uint8',
      }),
      resultEvent({
        revision: 3, kind: 'continuous', id: 'user_obs_value_1', nObs: 3,
        meta: { key: 'T cell markers score', origin: 'analysis' },
        cells: null, values: [0.25, -1, 3.5], valueType: 'float32',
      }),
      resultEvent({
        revision: 4, kind: 'geneSet', id: 'gene_set_1', nObs: 10,
        // Genes by identifier (the var index), with the names shown when a
        // var column names the genes (here a CELLxGENE file's feature_name).
        meta: {
          name: 'T cell markers', description: 'From the notebook',
          genes: ['ENSG00000198851', 'ENSG00000167286', 'ENSG00000168685'], symbols: ['CD3E', 'CD3D', 'IL7R'],
          origin: 'notebook',
        },
        cells: [], values: null,
      }),
      resultEvent({
        revision: 5, kind: 'visibility', id: 'visible', nObs: 10,
        meta: {}, cells: [1, 2, 3], values: null,
      }),
      resultEvent({
        revision: 6, kind: 'subset', id: 'open', nObs: 10,
        meta: { digest: '0123456789abcdef' }, cells: [0, 3, 4, 9], values: null,
      }),
      // Genes named by the var index: no symbols beside them.
      resultEvent({
        revision: 7, kind: 'geneSet', id: 'markers_1', nObs: 10,
        meta: { name: 'B cell', description: 'Marker genes', genes: ['MS4A1', 'CD79A'], symbols: null, origin: 'markers' },
        cells: [], values: null,
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
    runtimes: Object.fromEntries(
      Object.entries(VIEWER_HOST_RUNTIMES).map(([runtime, { label, language }]) => [runtime, { label, language }])
    ),
    protocolDocument: viewerProtocolDocument(),
    commands: Object.fromEntries(Object.entries(VIEWER_COMMAND_FIELDS).map(([type, keys]) => [type, [...keys]])),
    binaryCommands: Object.fromEntries(
      Object.entries(VIEWER_BINARY_COMMAND_HEADER_FIELDS).map(([type, keys]) => [type, [...keys]])
    ),
    action: {
      typePattern: ACTION_TYPE_PATTERN.source,
      arrayFields: [...VIEWER_ACTION_ARRAY_FIELDS],
      stepFields: [...VIEWER_ACTION_STEP_FIELDS],
      unrecorded: { ...VIEWER_ACTION_UNRECORDED },
      body: 'binary action: each of header.arrays in order, length elements of its type, little-endian, '
        + 'placed in params at its path (keys and list indices ending in a key params does not hold); '
        + 'action_result: the outcome as UTF-8 JSON',
      turn: 'turn and turnLabel: both exact text (the turn\'s id; what it was asked to do), or both null',
    },
    agent: {
      connectionFields: [...VIEWER_AGENT_CONNECTION_FIELDS],
      connectionIdPattern: VIEWER_AGENT_CONNECTION_ID_PATTERN,
      body: 'agent_tools: the MCP tools (a JSON array) as UTF-8 JSON; agent_result: the MCP tool result '
        + '({content, isError, ...}) as UTF-8 JSON; every agent_call is answered by exactly one agent_result',
    },
    history: {
      changeKinds: [...VIEWER_HISTORY_CHANGE_KINDS],
      sessionLoadedTrackerFields: [...VIEWER_SESSION_LOADED_TRACKER_FIELDS],
      loadSession: 'binary load_session: the header padded to a multiple of 4 bytes, then the .cellucid-session file; '
        + 'name is the file\'s name without a folder',
    },
    events: Object.fromEntries(Object.entries(VIEWER_EVENT_FIELDS).map(([type, keys]) => [type, [...keys]])),
    binaryEvents: Object.fromEntries(
      Object.entries(VIEWER_BINARY_EVENT_HEADER_FIELDS).map(([type, keys]) => [type, [...keys]])
    ),
    results: {
      kinds: Object.fromEntries(Object.entries(VIEWER_RESULT_META_FIELDS).map(([kind, keys]) => [kind, [...keys]])),
      highlightTools: [...VIEWER_HIGHLIGHT_TOOLS],
      origins: [...VIEWER_RESULT_ORIGINS],
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
