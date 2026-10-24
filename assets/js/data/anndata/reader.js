/**
 * The AnnData reader: one class that reads an AnnData dataset from an array
 * store (`formats/store.js`), whether the store is an `.h5ad` (HDF5) or an
 * AnnData Zarr store. It runs in the AnnData reader worker
 * (`anndata-reader-worker.js`); the main thread talks to it through
 * `AnnDataReaderClient` and never blocks on a file.
 *
 * Opening checks the dataset's structure from its metadata alone (the store
 * holds the whole node tree), reading only the obs and var indexes it needs.
 * Everything else is read when asked for, touching only what the request
 * needs: a field reads its arrays, a gene reads its column
 * (`matrix-columns.js`), an embedding reads its columns.
 *
 * @module data/anndata/reader
 */

import { connectivityEdgesOf } from '../connectivity-edges.js';
import { EmbeddingPayloads } from '../embedding-payload.js';
import {
  DEFAULT_KNN_KEY,
  requireObsmColumnSelection,
  requireObspKey,
} from '../data-mapping-candidates.js';
import { decodeAnnDataBoolean, isAnnDataMatrixDataKind, isAnnDataNumericValueKind } from '../anndata-value-kinds.js';
import {
  combineDatasetLifecycleFailures,
  createDatasetReloadSupersededError,
} from '../dataset-lifecycle-errors.js';
import { allocateTypedArray } from '../sparse-column-index.js';
import { yieldToMacrotask } from '../../utils/yield-macrotask.js';
import { createWorkerColumnStoreFactory } from '../column-store-placement.js';
import { onAbort } from '../../formats/io/abort.js';
import { residencyBudgetBytes } from '../memory-budget.js';
import { isGroup } from '../../formats/store.js';
import {
  NULLABLE_ENCODINGS,
  attributeValue,
  child,
  encodingType,
  numpyDtypeName,
  requireArray,
  requireExactStringAttribute,
  requireMapping,
  requirePrimitiveKind,
  shapeFromAttribute,
  shapeOf,
  validateArrayEncoding,
  validateDataFrame,
  validateOneDimensional,
  valueKind,
} from './elements.js';
import {
  categoryCount,
  nullableContract,
  probeColumns,
  readBooleanColumn,
  readCategories,
  readCodes,
  readDataFrameIndex,
  readGeneNameColumn,
  readNullableValues,
  resolveCategoricalColumn,
  validateColumnAxis,
  validateColumnEncoding,
  validateCodes,
} from './dataframe.js';
import { readSparseMatrix, sparseContract } from './sparse.js';
import { openMatrixColumns, openMatrixRows, readCellSubset } from './matrix-access.js';
import { SLAB_BYTES, readFloat32, readIntegers, readRowSlabs, readStored } from './values.js';
import { currentLayoutView, isOlderAnnDataLayout } from './older-layouts.js';

const OBS_KINDS = ['string', 'float', 'int', 'uint', 'bool'];

/** Why a cancelled read stopped: its own signal's reason, else an AbortError. */
function abortReason(signal) {
  return signal.reason ?? new DOMException('The read was cancelled.', 'AbortError');
}

/**
 * `promise`, or a rejection as soon as `signal` aborts: a read waiting on
 * shared work (a gene index other reads still need) stops waiting at once,
 * and the shared work goes on.
 */
function untilAborted(promise, signal) {
  if (signal === null || signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const stopWaiting = onAbort(signal, () => reject(abortReason(signal)));
    promise.then(
      value => {
        stopWaiting();
        resolve(value);
      },
      error => {
        stopWaiting();
        reject(error);
      }
    );
  });
}

/** Distinct-or-repeated whole positions within `[0, extent)`, as an array. */
function requirePositions(values, extent, label) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) {
    throw new TypeError(`${label} positions must be an array`);
  }
  const positions = Array.from(values, Number);
  for (const position of positions) {
    if (!Number.isSafeInteger(position) || position < 0 || position >= extent) {
      throw new RangeError(`${label} ${String(position)} is outside [0, ${extent})`);
    }
  }
  return positions;
}

/**
 * Children of `uns['cellucid']` the tree read leaves out: `session` is the
 * record the Python package's `apply_cellucid_session_to_anndata` keeps of a
 * session applied to the file, which can be large and which the viewer does
 * not use; `outlierQuantiles` holds one array per categorical field
 * (several MB each), so opening describes it (`describeStoredOutlierQuantiles`)
 * and a field's array is read only when its outlier filter is used
 * (`readStoredOutlierQuantiles`).
 */
const CELLUCID_UNREAD_KEYS = Object.freeze(['session', 'outlierQuantiles']);

/**
 * What `uns['cellucid']['outlierQuantiles']` holds, from its metadata and two
 * scalars: `{latentKey, minPoints, fields: {<obs key>: {shape, dtype}}}` as
 * plain JSON values (`anndata-cellucid-metadata.js` checks them). No field's
 * values are read.
 */
async function describeStoredOutlierQuantiles(node, readOptions) {
  const label = "uns['cellucid']['outlierQuantiles']";
  if (!isGroup(node)) throw unsCellucidError(`${label} must be a mapping`);
  const scalar = async key => (node.has(key) ? readUnsTree(node.get(key), `${label}['${key}']`, readOptions) : undefined);
  const [latentKey, minPoints] = await Promise.all([scalar('latentKey'), scalar('minPoints')]);
  const description = { latentKey, minPoints, fields: {} };
  for (const key of node.keys()) {
    if (key !== 'latentKey' && key !== 'minPoints' && key !== 'fields') description[key] = null;
  }
  if (node.has('fields')) {
    const fields = node.get('fields');
    if (!isGroup(fields)) throw unsCellucidError(`${label}['fields'] must be a mapping`);
    for (const key of fields.keys()) {
      const array = fields.get(key);
      description.fields[key] = array?.kind === 'array'
        ? { shape: [...array.shape], dtype: valueKind(array) === 'float' ? `float${8 * (array.dtype?.bytes ?? 0)}` : valueKind(array) }
        : { shape: null, dtype: 'group' };
    }
  } else {
    description.fields = undefined;
  }
  return description;
}

/** `uns['cellucid']` as plain JSON values, its stored outlier quantiles described. */
async function readUnsCellucid(node, readOptions) {
  const [cellucid, outliers] = await Promise.all([
    readUnsTree(node, "uns['cellucid']", readOptions, CELLUCID_UNREAD_KEYS),
    isGroup(node) && node.has('outlierQuantiles')
      ? describeStoredOutlierQuantiles(node.get('outlierQuantiles'), readOptions)
      : null,
  ]);
  if (outliers !== null) cellucid.outlierQuantiles = outliers;
  return cellucid;
}

/**
 * A refusal of what `uns['cellucid']` holds, written for the person who opened
 * the file and shown as it is (`explained`, which survives the worker's error
 * serialization).
 */
function unsCellucidError(message) {
  const error = new TypeError(
    `${message}. uns['cellucid'] is what a file says about itself for Cellucid; ` +
    'write it again with cellucid.prepare() in Python or cellucid_prepare() in R, or remove it.'
  );
  error.code = 'INVALID_FORMAT';
  error.details = { explained: true };
  return error;
}

/** One stored scalar as JSON would hold it. */
function unsScalar(value, kind, label) {
  if (kind === 'bool') return Boolean(value);
  if (kind === 'string') return value;
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw unsCellucidError(`${label} is an integer beyond 2^53`);
    return number;
  }
  if (typeof value === 'number') return value;
  throw unsCellucidError(`${label} must hold text, numbers or booleans`);
}

/**
 * Read one `uns` subtree as plain JSON values: a mapping (an AnnData `dict`
 * group, or a plain group as files before anndata 0.8 write it) becomes an
 * object, a scalar array its value, a one-dimensional array a list. Anything
 * else (a dataframe, a matrix, an array of more dimensions) is refused, since
 * no Cellucid metadata is stored that way.
 *
 * @param {Object} node
 * @param {string} label - Where the node is, for messages
 * @param {Object} readOptions
 * @param {ReadonlyArray<string>} [unread] - Children of this node left unread
 * @returns {Promise<unknown>}
 */
async function readUnsTree(node, label, readOptions, unread = []) {
  if (isGroup(node)) {
    const declared = encodingType(node);
    if (declared !== '' && declared !== 'dict') {
      throw unsCellucidError(`${label} is stored as '${declared}'; it must be a mapping (a dict), a list or a single value`);
    }
    const keys = node.keys().filter(key => !unread.includes(key));
    const values = await Promise.all(keys.map(key => readUnsTree(node.get(key), `${label}['${key}']`, readOptions)));
    const object = {};
    keys.forEach((key, index) => { object[key] = values[index]; });
    return object;
  }
  if (node?.kind !== 'array') throw unsCellucidError(`${label} must be a mapping, a list or a single value`);
  const kind = valueKind(node);
  if (!['string', 'float', 'int', 'uint', 'bool'].includes(kind)) {
    throw unsCellucidError(`${label} must hold text, numbers or booleans`);
  }
  if (node.shape.length > 1) {
    throw unsCellucidError(`${label} is a ${node.shape.length}-dimensional array; it must be a list or a single value`);
  }
  const value = await node.read(undefined, readOptions);
  if (node.shape.length === 0) return unsScalar(value, kind, label);
  return Array.from(value, element => unsScalar(element, kind, label));
}

/**
 * `uns['title']` as a file names itself (every CELLxGENE file does), else
 * null: a string, or a one-element string array as R writers and anndata 0.6
 * leave it. A title that cannot be read is no title.
 */
async function readUnsTitle(root, readOptions) {
  const title = child(child(root, 'uns'), 'title');
  if (title?.kind !== 'array' || valueKind(title) !== 'string') return null;
  if (!title.shape.every(extent => extent === 1)) return null;
  let value;
  try {
    value = await title.read(undefined, readOptions);
    if (typeof value !== 'string') value = value?.[0];
  } catch (error) {
    // A title only names the dataset: one that cannot be read is no title,
    // and never stops the file from opening.
    console.warn(`[AnnDataReader] uns['title'] could not be read; the file name is used instead (${error?.message ?? error})`);
    return null;
  }
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The colours Scanpy keeps for one categorical obs field,
 * `uns['<key>_colors']` (one colour per category, in category order, as
 * `sc.pl.*` writes them), as the stored text; null when the file has none.
 * Which entries are colours, and whether there are enough of them, is the
 * page's to judge (`scanpyCategoryPalette`). A palette that cannot be read
 * is no palette: the field is still shown, in Cellucid's colours.
 *
 * @param {Object} root
 * @param {string} key
 * @param {{signal?: AbortSignal|null}} readOptions
 * @returns {Promise<string[]|null>}
 */
async function readObsFieldColors(root, key, readOptions) {
  const node = child(child(root, 'uns'), `${key}_colors`);
  if (node?.kind !== 'array' || valueKind(node) !== 'string' || node.shape.length !== 1) return null;
  try {
    const values = await node.read(undefined, readOptions);
    return Array.from(values, value => String(value));
  } catch (error) {
    if (readOptions.signal?.aborted) throw error;
    console.warn(`[AnnDataReader] uns['${key}_colors'] could not be read; '${key}' is shown in Cellucid's colours (${error?.message ?? error})`);
    return null;
  }
}

/**
 * `uns['log1p']` as `sc.pp.log1p` records it: null when the file has none,
 * else `{base}`, null for the natural logarithm. Scanpy writes `base` as None
 * for e, which anndata stores as nothing; a base that is not a positive
 * number other than 1 is not a base a logarithm has, and reads as e too.
 *
 * @returns {Promise<{base: number|null}|null>}
 */
async function readLog1pRecord(root, readOptions) {
  const record = child(child(root, 'uns'), 'log1p');
  if (record === null || record === undefined) return null;
  const node = isGroup(record) ? child(record, 'base') : null;
  if (node?.kind !== 'array' || !['float', 'int', 'uint'].includes(valueKind(node))) return { base: null };
  if (!node.shape.every(extent => extent === 1)) return { base: null };
  let value = await node.read(undefined, readOptions);
  if (typeof value !== 'number' && typeof value !== 'bigint') value = value?.[0];
  const base = Number(value);
  return { base: Number.isFinite(base) && base > 0 && base !== 1 ? base : null };
}

/**
 * What a dataset catalog lists about one AnnData store, read from its
 * metadata and `uns` alone: its cell and gene counts (from the expression
 * matrix's shape, else the dataframe indexes' shapes), `uns['title']` and
 * `uns['cellucid']` as stored. No index, matrix or column is read, so
 * describing a large remote store costs its metadata and a few small reads.
 *
 * @param {Object} store - An opened store root (`openHdf5` / `openZarr`)
 * @param {{format: import('./elements.js').AnnDataFormat}} options
 * @param {Object} [readOptions]
 * @returns {Promise<{nObs: number, nVars: number, hasExpressionMatrix: boolean,
 *   title: string|null, cellucid: Object|null}>}
 */
export async function describeAnnDataStore(store, { format }, readOptions = {}) {
  if (!isGroup(store)) throw new TypeError('An AnnData store is described by its root group.');
  const root = isOlderAnnDataLayout(store) ? currentLayoutView(store) : store;
  requireExactStringAttribute(root, 'encoding-type', 'anndata', `${format.file} root`);
  if (!root.has('obs') || !root.has('var')) {
    throw new Error(`${format.file} obs and var are required and must be current AnnData dataframes`);
  }
  const extentOf = (frame, label) => {
    const { indexKey } = validateDataFrame(frame, format, label);
    return shapeOf(frame.get(indexKey), `${label} index`, 1)[0];
  };
  let nObs;
  let nVars;
  const hasExpressionMatrix = root.has('X');
  if (hasExpressionMatrix) {
    const X = root.get('X');
    [nObs, nVars] = isGroup(X) ? sparseContract(X, format, 'Sparse X').shape : shapeOf(X, 'Dense X', 2);
  } else {
    nObs = extentOf(root.get('obs'), `${format.file} obs`);
    nVars = extentOf(root.get('var'), `${format.file} var`);
  }
  const unsCellucid = child(child(root, 'uns'), 'cellucid');
  const [title, cellucid] = await Promise.all([
    readUnsTitle(root, readOptions),
    unsCellucid === null ? null : readUnsCellucid(unsCellucid, readOptions),
  ]);
  return { nObs, nVars, hasExpressionMatrix, title, cellucid };
}

/**
 * Describe one AnnData element from its metadata, for the data-mapping
 * catalog. Nothing is read and nothing is refused: an element this reader
 * cannot classify is storage `other`.
 */
function probeElement(key, node) {
  const other = { key, storage: 'other', shape: null, dtype: 'object', numeric: false, nnz: null };
  try {
    if (node?.kind === 'array') {
      return {
        key,
        storage: 'dense',
        shape: shapeOf(node, key),
        dtype: numpyDtypeName(node),
        numeric: isAnnDataNumericValueKind(valueKind(node)),
        nnz: null,
      };
    }
    if (!isGroup(node)) return other;
    const declared = encodingType(node);
    if (declared === 'csr_matrix' || declared === 'csc_matrix') {
      const shape = shapeFromAttribute(attributeValue(node, 'shape'), key);
      const data = child(node, 'data');
      if (data?.kind !== 'array') return { ...other, storage: declared.slice(0, 3), shape };
      return {
        key,
        storage: declared.slice(0, 3),
        shape,
        dtype: numpyDtypeName(data),
        numeric: isAnnDataNumericValueKind(valueKind(data)),
        nnz: shapeOf(data, key)[0] ?? null,
      };
    }
    if (declared === 'dataframe') {
      const indexKey = attributeValue(node, '_index');
      const columnOrder = attributeValue(node, 'column-order');
      const index = typeof indexKey === 'string' ? child(node, indexKey) : null;
      const rows = index?.kind === 'array' ? shapeOf(index, key)[0] : null;
      const columns = Array.isArray(columnOrder) ? columnOrder.length : null;
      return {
        ...other,
        storage: 'dataframe',
        shape: rows === null || rows === undefined || columns === null ? null : [rows, columns],
      };
    }
  } catch {
    return other;
  }
  return other;
}

/**
 * Reads one AnnData dataset. One instance reads one store; it lives in the
 * AnnData reader worker.
 */
export class AnnDataReader {
  constructor() {
    /**
     * Work on the reader thread someone waits for running now (a graph's
     * extraction), and what waits for there to be none: an index built
     * ahead of need takes the reader thread only between them
     * (`_yieldToForeground`). Only work that never waits for an index counts.
     */
    this._foreground = 0;
    this._foregroundIdle = [];
    /** @type {Object|null} The store root, in the current layout */
    this._root = null;
    /** @type {Object|null} The store as opened (closed with the reader) */
    this._store = null;
    /** @type {import('./elements.js').AnnDataFormat|null} */
    this._format = null;
    this._name = null;
    /** @type {import('../../formats/io/link.js').LinkMeter|null} The link to the store (see `open`) */
    this._link = null;
    this._nObs = 0;
    this._nVars = 0;
    this._obsKeys = [];
    /**
     * The var index as stored: names, possibly repeated. The adapter makes
     * them unique with the data-mapping rule (`makeUniqueNames`).
     * @type {string[]}
     */
    this._varNames = [];
    /** @type {Map<string, Object>} Field types, categories, names */
    this._cache = new Map();
    /**
     * The expression matrices whose columns are read, and how each one's
     * columns are reached, least recently read first. The matrix read now
     * is the last; a built gene index of an earlier one is kept while every
     * kept index fits the `columnIndex` memory budget, so switching back to
     * it reads nothing again (`_settleMatrices`).
     * @type {Map<string, {element: string, columns: Object|null, loadPromise: Promise|null}>}
     */
    this._matrices = new Map();
    /** @type {Promise<string|null>|null} `uns['title']`, read while opening */
    this._title = null;
    /**
     * `uns['cellucid']` as stored (`readUnsTree`), or null when the file has
     * none; read while opening and validated by the adapter
     * (`anndata-cellucid-metadata.js`).
     * @type {Promise<Object|null>|null}
     */
    this._cellucid = null;
    /**
     * Row access (one cell's genes) to one matrix; like `_matrix`, one at a
     * time.
     * @type {{element: string, rows: Promise<Object>}|null}
     */
    this._rows = null;
    /**
     * Column pointers of a CSC matrix being read ahead of its first gene, by
     * element: `X`'s are read while the dataset opens, beside its indexes,
     * so the first gene shown is one round trip.
     * @type {Map<string, Promise<ArrayLike<number>>>}
     */
    this._pointerReads = new Map();
    this._generation = 0;
    this._openRequestId = 0;
    this._closed = false;
    /** Where gene-column indexes are kept (memory, else disk). */
    this.columnStoreFactory = createWorkerColumnStoreFactory();
    /**
     * Makes the activity (`formats/io/activity.js`) one operation reads
     * under, so what each read fetched and decoded is counted and reported;
     * null counts nothing.
     * @type {((what: {kind: string, label: string}) => import('../../formats/io/activity.js').ReadActivity)|null}
     */
    this.createActivity = null;
    /**
     * Embedding and vector-field payloads made from `obsm` columns
     * (`embedding-payload.js`), forgotten whenever the caches are cleared.
     */
    this._payloads = new EmbeddingPayloads(
      (key, columns, options) => this.readObsmColumns(key, columns, options),
      () => this._generation
    );
  }

  /**
   * Run `operation(readOptions)` under one activity of `kind` named `label`,
   * read for the job `owner` (if any), finished with the outcome. `signal`
   * cancels it: its reads stop, and so does any wait on shared work. @private
   */
  async _track(kind, label, operation, signal = null, owner = null, keys = null) {
    const activity = this.createActivity?.({ kind, label, owner, keys }) ?? null;
    try {
      if (signal?.aborted) throw abortReason(signal);
      const result = await untilAborted(operation({ activity, signal }), signal);
      activity?.finish();
      return result;
    } catch (error) {
      activity?.finish(error);
      throw error;
    }
  }

  /** Run `work` as an operation someone waits for (see `_yieldToForeground`). @private */
  async _inForeground(work) {
    this._foreground++;
    try {
      return await work();
    } finally {
      if (--this._foreground === 0) {
        const waiting = this._foregroundIdle;
        this._foregroundIdle = [];
        for (const resolve of waiting) resolve();
      }
    }
  }

  /**
   * Where an index built ahead of need yields between parts of its work:
   * after a macrotask, and, while no read waits for the index (`waited`),
   * until no extraction someone waits for runs (`_inForeground`). The
   * index's work is the reader thread's, and a graph's extraction took turns
   * with it (Suo's neighbour graph: 0.8 s while the index of the cells asked
   * for before it was built, 0.4 s alone). Reads are not counted: one may
   * wait for the index itself.
   * @private
   */
  async _yieldToForeground(waited) {
    await yieldToMacrotask();
    while (!waited && this._foreground > 0) {
      await new Promise(resolve => this._foregroundIdle.push(resolve));
    }
  }

  _assertOpenRequest(requestId) {
    if (requestId !== this._openRequestId) {
      throw createDatasetReloadSupersededError(`${this._format?.file ?? 'AnnData'} open request was superseded or closed.`);
    }
  }

  /**
   * Open one store.
   *
   * @param {Object} store - An opened store root (`openHdf5` / `openZarr`), with `close()`
   * @param {{format: import('./elements.js').AnnDataFormat, name: string, decodedChunkBytes?: number,
   *   link?: import('../../formats/io/link.js').LinkMeter|null}} options
   *   `link`: the link to the store, measured as it is read (`openAnnDataStore`).
   *   Over a link that delivers bytes as fast as a disk (`link.readsAhead`), a
   *   cell-major matrix is indexed by gene as soon as it is prepared, values
   *   with the structure, as a local file is; over a slower one, the index
   *   waits for the first gene and reads values only where genes need them,
   *   so opening downloads nothing a view has not asked for. A store without
   *   a link (one built in memory) has nothing between it and the reader and
   *   is read ahead.
   *   `activity`: the activity that opening the store started, which reading
   *   the AnnData structure continues (else it gets its own).
   */
  async open(store, { format, name, decodedChunkBytes = residencyBudgetBytes('decodedBlocks'), link = null, activity = null }) {
    if (!isGroup(store)) throw new TypeError('An AnnData reader opens a store root group.');
    const requestId = ++this._openRequestId;
    const candidate = new AnnDataReader();
    candidate._format = format;
    candidate._name = name;
    candidate._store = store;
    candidate._decodedChunkBytes = decodedChunkBytes;
    candidate._link = link;
    candidate.createActivity = this.createActivity;
    try {
      // A file written before anndata 0.8 is read through its current-layout
      // view; everything below reads one layout.
      candidate._root = isOlderAnnDataLayout(store) ? currentLayoutView(store) : store;
      if (activity === null) {
        await candidate._track('open', `the structure of ${name}`, options => candidate._readStructure(options));
      } else {
        await candidate._readStructure({ activity });
      }
      this._assertOpenRequest(requestId);
      this._adopt(candidate);
      console.log(`[AnnDataReader] Opened ${name}: ${this._nObs} cells, ${this._nVars} genes`);
    } catch (error) {
      let terminal = error instanceof Error && error.message.length > 0
        ? error
        : new TypeError(`${format.file} opening must reject with a non-empty Error.`, { cause: error });
      try {
        candidate._store = null;
        candidate.close();
      } catch (cleanupFailure) {
        terminal = combineDatasetLifecycleFailures(terminal, cleanupFailure, `${format.file} opening and candidate cleanup both failed.`);
      }
      throw terminal;
    }
  }

  _adopt(candidate) {
    this._releaseCurrentState();
    for (const key of ['_root', '_store', '_format', '_name', '_nObs', '_nVars', '_obsKeys', '_varNames', '_cache', '_matrices', '_decodedChunkBytes', '_title', '_cellucid', '_link', '_pointerReads']) {
      this[key] = candidate[key];
    }
    this._closed = false;
    candidate._root = null;
    candidate._store = null;
  }

  /** @private */
  async _readStructure(readOptions = {}) {
    const root = this._root;
    const format = this._format;
    const fileLabel = `${format.file} root`;
    requireExactStringAttribute(root, 'encoding-type', 'anndata', fileLabel);
    requireExactStringAttribute(root, 'encoding-version', '0.1.0', fileLabel);
    if (!root.has('obs')) throw new Error(`${format.file} obs is required and must be a current AnnData dataframe`);
    if (!root.has('var')) throw new Error(`${format.file} var is required and must be a current AnnData dataframe`);
    const obs = root.get('obs');
    const var_ = root.get('var');
    const obsSchema = validateDataFrame(obs, format, `${format.file} obs`);
    const varSchema = validateDataFrame(var_, format, `${format.file} var`);

    const hasX = root.has('X');
    let nObs = 0;
    let nVars = 0;
    if (hasX) {
      const X = root.get('X');
      if (isGroup(X)) {
        const sparse = sparseContract(X, format, 'Sparse X');
        [nObs, nVars] = sparse.shape;
        if (sparse.format === 'csc') {
          // A gene of a CSC matrix reads its range of the pointers first:
          // read them now, beside the indexes, and the first gene is one
          // round trip. A failure reaches the first gene read, not opening.
          const pointers = readIntegers(sparse.indptrArray, 0, nVars + 1, 'Sparse X indptr', readOptions);
          pointers.catch(() => {});
          this._pointerReads.set('X', pointers);
        }
      } else {
        validateArrayEncoding(X, format, 'Dense X', 'array');
        [nObs, nVars] = shapeOf(X, 'Dense X', 2);
        if (!isAnnDataMatrixDataKind(valueKind(X))) throw new Error('Dense X must use a numeric or boolean dtype');
      }
    }
    for (const key of obsSchema.columnOrder) {
      // Checked before any value is read, so a malformed column fails fast.
      validateColumnEncoding(obs.get(key), format, `Observation dataframe column '${key}'`);
    }
    // The title (one small read) is read beside the indexes: dataset
    // metadata then never waits a round trip for it.
    this._title = readUnsTitle(root, readOptions);
    this._title.catch(() => {});
    // What the file says about itself for Cellucid is part of opening it: a
    // malformed entry refuses the file, so it is read with the indexes.
    const unsCellucid = child(child(root, 'uns'), 'cellucid');
    const [obsIndex, varIndex, cellucid] = await Promise.all([
      readDataFrameIndex(obs.get(obsSchema.indexKey), format, 'Observation index', hasX ? nObs : null, false, readOptions),
      readDataFrameIndex(var_.get(varSchema.indexKey), format, 'Variable index', hasX ? nVars : null, true, readOptions),
      unsCellucid === null ? null : readUnsCellucid(unsCellucid, readOptions),
    ]);
    this._cellucid = cellucid;
    if (!hasX) {
      nObs = obsIndex.length;
      nVars = varIndex.length;
    }
    for (const key of obsSchema.columnOrder) validateColumnAxis(obs, key, format, 'Observation dataframe', nObs);
    for (const key of varSchema.columnOrder) validateColumnAxis(var_, key, format, 'Variable dataframe', nVars);
    if (root.has('obsm')) requireMapping(root.get('obsm'), format, `${format.file} obsm mapping`);
    if (nObs === 0) console.warn('[AnnDataReader] AnnData has 0 cells');
    if (!hasX) console.warn('[AnnDataReader] No X matrix: gene expression is not available');
    this._nObs = nObs;
    this._nVars = nVars;
    this._obsKeys = [...obsSchema.columnOrder];
    // A repeated name is kept as stored: the adapter makes the gene list
    // unique with the data-mapping rule, as cellucid serve does.
    this._varNames = varIndex.values;
  }

  get nObs() { return this._nObs; }

  get nVars() { return this._nVars; }

  get obsKeys() { return [...this._obsKeys]; }

  get varNames() { return [...this._varNames]; }

  /** Whether the dataset has an expression matrix (`X` may be absent). */
  get hasExpressionMatrix() { return this._root?.has('X') === true; }

  get isOpen() { return this._root !== null; }

  /**
   * Describe, from metadata alone, every element the data-mapping catalog
   * lists: the `obsm` and `obsp` entries, the var columns, `X`, the layers
   * and `raw`. No array value is read.
   */
  async probeMapping() {
    this._ensureOpen();
    const root = this._root;
    const format = this._format;
    const mappingProbes = name => {
      if (!root.has(name)) return [];
      const group = requireMapping(root.get(name), format, `${format.file} ${name} mapping`);
      return group.keys().map(key => probeElement(key, group.get(key)));
    };
    let raw = null;
    const rawGroup = child(root, 'raw');
    if (isGroup(rawGroup) && rawGroup.has('X')) {
      const rawX = probeElement('X', rawGroup.get('X'));
      raw = {
        nVars: rawX.shape?.length === 2 ? rawX.shape[1] : 0,
        X: { storage: rawX.storage, dtype: rawX.dtype },
        varColumns: rawGroup.has('var') ? probeColumns(rawGroup.get('var'), format, `${format.file} raw.var`) : [],
      };
    }
    let matrixX = null;
    if (root.has('X')) {
      const probe = probeElement('X', root.get('X'));
      matrixX = { storage: probe.storage, dtype: probe.dtype };
    }
    return {
      nObs: this._nObs,
      nVars: this._nVars,
      obsm: mappingProbes('obsm'),
      obsp: mappingProbes('obsp'),
      varColumns: probeColumns(root.get('var'), format, `${format.file} var`),
      X: matrixX,
      layers: mappingProbes('layers'),
      raw,
      log1p: await readLog1pRecord(root, {}),
    };
  }

  /** One dense numeric `obsm` array, checked: one row per cell, one or two dimensions. @private */
  _obsmArray(key) {
    const label = `obsm['${key}']`;
    const obsm = requireMapping(child(this._root, 'obsm'), this._format, `${this._format.file} obsm mapping`);
    if (!obsm.has(key)) throw new Error(`${label} does not exist in this file`);
    const array = obsm.get(key);
    if (isGroup(array)) {
      // A sparse matrix, a dataframe, an awkward array: named, never misread.
      const encoding = attributeValue(array, 'encoding-type');
      throw new Error(
        `${label} is ${typeof encoding === 'string' && encoding.length > 0 ? `an '${encoding}' element` : 'a group'}, ` +
        'not a dense array; Cellucid reads embeddings stored as dense numeric arrays'
      );
    }
    if (valueKind(array) === 'string') {
      throw new Error(`${label} holds text, not numbers; Cellucid reads embeddings stored as dense numeric arrays`);
    }
    validateArrayEncoding(array, this._format, label, 'array');
    const shape = shapeOf(array, label);
    if (shape.length !== 1 && shape.length !== 2) throw new Error(`${label} must be a one- or two-dimensional array`);
    if (shape[0] !== this._nObs) throw new Error(`${label} has ${shape[0]} rows but the dataset has ${this._nObs} cells`);
    if (!isAnnDataNumericValueKind(valueKind(array))) throw new Error(`${label} must use a numeric dtype`);
    return { array, shape, width: shape.length === 1 ? 1 : shape[1], label };
  }

  /**
   * Every row of `obsm[key]`, every column, in row order, one slab at a
   * time, so the array is never held whole: `visit(block, rowStart, rowEnd)`
   * receives row-major values (numbers, or BigInts for 64-bit integers) and
   * runs synchronously. `signal` cancels the pass; `kind` and `label` name
   * the activity it runs under (an embedding read, by default).
   *
   * @param {string} key
   * @param {(block: ArrayLike<number|bigint>, rowStart: number, rowEnd: number) => void} visit
   * @param {{signal?: AbortSignal|null, kind?: string, label?: string|null}} [options]
   * @returns {Promise<number>} The array's width
   */
  async forEachObsmRowSlab(key, visit, { signal = null, kind = 'embedding', label: activityLabel = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { array, shape, width, label } = this._obsmArray(key);
    return this._track(kind, activityLabel ?? label, async readOptions => {
      for await (const slab of readRowSlabs(array, 0, shape[0], readOptions)) {
        this._assertGeneration(generation, `reading ${label}`);
        visit(slab.values, slab.rowStart, slab.rowEnd);
      }
      return width;
    }, signal);
  }

  /**
   * What reading all of `obsm[key]` costs: its stored (compressed) bytes, or
   * null when the store cannot say without reading (a Zarr folder over HTTP
   * lists no sizes), and its bytes as values.
   *
   * @param {string} key
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<{storedBytes: number|null, valueBytes: number}>}
   */
  async obsmReadCost(key, { signal = null } = {}) {
    this._ensureOpen();
    const { array, shape } = this._obsmArray(key);
    const valueBytes = shape.reduce((product, extent) => product * extent, 1) * (array.dtype?.bytes ?? 8);
    let storedBytes = null;
    if (typeof array.storedBytes === 'function') {
      storedBytes = await array.storedBytes(shape.map(extent => [0, extent]), { signal });
    }
    return { storedBytes: Number.isFinite(storedBytes) ? storedBytes : null, valueBytes };
  }

  /** `uns['cellucid']['outlierQuantiles']['fields'][key]`, checked: float32, one value per cell. @private */
  _storedOutlierArray(fieldKey) {
    const label = `uns['cellucid']['outlierQuantiles']['fields']['${fieldKey}']`;
    const fields = child(child(child(child(this._root, 'uns'), 'cellucid'), 'outlierQuantiles'), 'fields');
    const array = fields === null ? null : child(fields, fieldKey);
    if (array?.kind !== 'array') throw new Error(`${label} does not exist in this file`);
    if (valueKind(array) !== 'float' || array.dtype?.bytes !== 4 || array.shape.length !== 1 || array.shape[0] !== this._nObs) {
      throw new Error(`${label} must be ${this._nObs} float32 values, one per cell`);
    }
    return { array, label };
  }

  /**
   * The outlier quantiles a file stores for one obs field (written by
   * `prepare()` / `cellucid_prepare()` with the latent space), as stored:
   * NaN where a cell has none.
   *
   * @param {string} fieldKey
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Float32Array>}
   */
  async readStoredOutlierQuantiles(fieldKey, { signal = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { array, label } = this._storedOutlierArray(fieldKey);
    return this._track('outliers', `stored outlier quantiles of obs['${fieldKey}']`, async readOptions => {
      const values = await array.read(undefined, readOptions);
      this._assertGeneration(generation, `reading ${label}`);
      if (!(values instanceof Float32Array) || values.length !== this._nObs) {
        throw new Error(`${label} did not read as ${this._nObs} float32 values`);
      }
      return values;
    }, signal);
  }

  /** The stored bytes of one field's stored outlier quantiles, or null when the store cannot say. */
  async storedOutlierQuantilesBytes(fieldKey, { signal = null } = {}) {
    this._ensureOpen();
    const { array } = this._storedOutlierArray(fieldKey);
    if (typeof array.storedBytes !== 'function') return null;
    const bytes = await array.storedBytes([[0, this._nObs]], { signal });
    return Number.isFinite(bytes) ? bytes : null;
  }

  /**
   * The selected columns of one dense `obsm` array, unnormalized, one row per
   * cell, `result[row * columns.length + i]`: float32 values for a float32
   * array (exactly as stored, half the bytes), float64 for any other numeric
   * type (64-bit integers converted as `Number` does). Only the
   * selected columns' chunks are read: a selection spanning at most twice
   * its own width is read as one column range, otherwise column by column,
   * every range at once. `signal` cancels the read.
   */
  async readObsmColumns(key, columns, { signal = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { array, shape, width, label } = this._obsmArray(key);
    const selected = requireObsmColumnSelection(columns, width, label);
    return this._track('embedding', `${label} columns ${selected.join(', ')}`, readOptions =>
      this._readObsmColumns(array, shape, selected, label, generation, readOptions), signal);
  }

  /** @private */
  async _readObsmColumns(array, shape, selected, label, generation, readOptions) {
    const nRows = shape[0];
    const nColumns = selected.length;
    const stored32 = valueKind(array) === 'float' && array.dtype?.bytes === 4;
    const result = allocateTypedArray(stored32 ? Float32Array : Float64Array, nRows * nColumns, label);
    const toNumber = value => (typeof value === 'bigint' ? Number(value) : value);
    if (shape.length === 1) {
      for await (const slab of readRowSlabs(array, 0, nRows, readOptions)) {
        const block = slab.values;
        for (let row = 0; row < block.length; row++) result[slab.rowStart + row] = toNumber(block[row]);
      }
    } else {
      const first = Math.min(...selected);
      const last = Math.max(...selected) + 1;
      const ranges = last - first <= 2 * nColumns
        ? [[first, last, selected.map((column, index) => [column, index])]]
        : selected.map((column, index) => [column, column + 1, [[column, index]]]);
      await Promise.all(ranges.map(async ([from, to, picks]) => {
        const blockWidth = to - from;
        // Every column of the range asked for, in order: a slab is already
        // laid out as the output is.
        const whole = blockWidth === nColumns && picks.every(([column, output], i) => column === from + i && output === i);
        for await (const slab of readRowSlabs(array, 0, nRows, { ...readOptions, columns: [from, to] })) {
          const block = slab.values;
          if (whole && !(block instanceof BigInt64Array) && !(block instanceof BigUint64Array)) {
            result.set(block, slab.rowStart * nColumns);
            continue;
          }
          for (const [column, outputColumn] of picks) {
            const offset = column - from;
            for (let row = slab.rowStart; row < slab.rowEnd; row++) {
              result[row * nColumns + outputColumn] = toNumber(block[(row - slab.rowStart) * blockWidth + offset]);
            }
          }
        }
      }));
    }
    this._assertGeneration(generation, `reading ${label}`);
    return result;
  }

  /**
   * One embedding's display coordinates, checked and normalized here
   * (`EmbeddingPayloads.embedding`), with their display transform and
   * bounds. `signal` cancels the read.
   *
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {boolean} normalize
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<import('../embedding-payload.js').EmbeddingPayload>}
   */
  readEmbedding(key, columns, normalize, { signal = null } = {}) {
    this._ensureOpen();
    return this._payloads.embedding(key, [...columns], normalize, { signal });
  }

  /**
   * One vector field's display vectors, scaled here by the transform of the
   * embedding it is bound to (`EmbeddingPayloads.vectors`), with the largest
   * magnitude. `signal` cancels the reads.
   *
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {{key: string, columns: ReadonlyArray<number>}} embedding
   * @param {boolean} normalize
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<{vectors: Float32Array, maxMagnitude: number}>}
   */
  readVectorField(key, columns, embedding, normalize, { signal = null } = {}) {
    this._ensureOpen();
    return this._payloads.vectors(
      key,
      [...columns],
      { key: embedding.key, columns: [...embedding.columns] },
      normalize,
      { signal }
    );
  }

  /**
   * The gene names of one var axis, as stored: the var index, or one var
   * column as text (null where a value is missing), with the index that names
   * the genes a column leaves empty. `axis` is `X` (shared by `X` and every
   * layer) or `raw`. Nothing is made unique here.
   *
   * @param {'X'|'raw'} axis
   * @param {string|null} column
   * @returns {Promise<{index: string[], values: Array<string|null>}>}
   */
  /**
   * One boolean column of `var` (axis `X`) or `raw.var` (axis `raw`) as
   * flags, one per gene of that axis, 1 where true: which genes a column such
   * as `highly_variable` marks. Read when asked for, never at open.
   *
   * @param {'X'|'raw'} axis
   * @param {string} column
   * @returns {Promise<Uint8Array>}
   */
  async readVarFlags(axis, column) {
    this._ensureOpen();
    const label = `${axis === 'raw' ? 'raw.var' : 'var'}['${column}']`;
    return this._track('names', `flags of ${label}`, async readOptions => {
      const generation = this._generation;
      const { index } = await this.readVarNames(axis, null);
      const frame = axis === 'raw' ? child(this._root, 'raw').get('var') : this._root.get('var');
      const { columnOrder } = validateDataFrame(frame, this._format, label);
      if (!columnOrder.includes(column)) throw new Error(`${label} does not exist`);
      const flags = await readBooleanColumn(frame, column, this._format, label, index.length, readOptions);
      this._assertGeneration(generation, `reading ${label}`);
      return flags;
    });
  }

  async readVarNames(axis, column) {
    this._ensureOpen();
    const cacheKey = `var_names:${axis}:${column === null ? '' : `column:${column}`}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const what = column === null ? `gene names of ${axis === 'raw' ? 'raw.var' : 'var'}` : `gene names from ${axis === 'raw' ? 'raw.var' : 'var'}['${column}']`;
    return this._track('names', what, readOptions => this._readVarNames(axis, column, cacheKey, readOptions));
  }

  /** @private */
  async _readVarNames(axis, column, cacheKey, readOptions) {
    const generation = this._generation;
    const format = this._format;
    let frame;
    let label;
    let index;
    if (axis === 'X') {
      frame = this._root.get('var');
      label = 'var';
      index = this._varNames;
    } else if (axis === 'raw') {
      const raw = child(this._root, 'raw');
      if (!isGroup(raw) || !raw.has('var') || !raw.has('X')) throw new Error('This file has no raw var axis');
      frame = raw.get('var');
      label = 'raw.var';
      const rawX = raw.get('X');
      const nRawVars = isGroup(rawX) ? sparseContract(rawX, format, 'raw.X').shape[1] : shapeOf(rawX, 'raw.X', 2)[1];
      const { indexKey } = validateDataFrame(frame, format, `${format.file} raw.var`);
      index = (await readDataFrameIndex(frame.get(indexKey), format, 'Raw variable index', nRawVars, true, readOptions)).values;
    } else {
      throw new TypeError(`Unknown var axis '${String(axis)}'`);
    }
    let values;
    if (column === null) {
      values = index;
    } else {
      const { columnOrder } = validateDataFrame(frame, format, `${format.file} ${label}`);
      if (!columnOrder.includes(column)) throw new Error(`${label} has no column '${column}'`);
      values = await readGeneNameColumn(frame, column, format, `${label}['${column}']`, index.length, readOptions);
    }
    this._assertGeneration(generation, `reading the gene names of ${label}`);
    const result = Object.freeze({ index, values });
    this._cache.set(cacheKey, result);
    return result;
  }

  /** The node, label and var count of one expression matrix. @private */
  _requireMatrixElement(element) {
    const root = this._root;
    const format = this._format;
    if (element === 'X') {
      if (!root.has('X')) throw new Error('This file has no X expression matrix');
      return { node: root.get('X'), label: 'X', nVars: this._nVars };
    }
    if (element === 'raw/X') {
      const raw = child(root, 'raw');
      if (!isGroup(raw) || !raw.has('X')) throw new Error('This file has no raw.X expression matrix');
      const node = raw.get('X');
      const shape = isGroup(node) ? sparseContract(node, format, 'raw.X').shape : shapeOf(node, 'raw.X', 2);
      return { node, label: 'raw.X', nVars: shape[1] };
    }
    if (typeof element === 'string' && element.startsWith('layers/')) {
      const name = element.slice('layers/'.length);
      const layers = root.has('layers') ? requireMapping(root.get('layers'), format, `${format.file} layers mapping`) : null;
      if (name.length === 0 || name.includes('/') || layers === null || !layers.has(name)) {
        throw new Error(`This file has no layer '${name}'`);
      }
      return { node: layers.get(name), label: `layers['${name}']`, nVars: this._nVars };
    }
    throw new TypeError(`Unknown expression matrix '${String(element)}'`);
  }

  /**
   * One column of one expression matrix -- one gene's value in every cell --
   * as float32. `element` is `X`, `layers/<name>` or `raw/X`; `index` is the
   * gene's position on that matrix's var axis. `signal` cancels the read;
   * a read for a job (`owner`, an analysis's) is a job read (kind `analysis`);
   * `keys` name the shared loads it reads for, which a job may join later.
   */
  async getMatrixColumn(element, index, { signal = null, owner = null, keys = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { label, nVars } = this._requireMatrixElement(element);
    if (!Number.isSafeInteger(index) || index < 0 || index >= nVars) {
      throw new RangeError(`${label} has no gene column ${String(index)}`);
    }
    return this._track(owner === null ? 'genes' : 'analysis', `gene ${index} of ${label}`, async readOptions => {
      const columns = await this._matrixColumns(element, generation, readOptions);
      const result = await columns.column(index, readOptions);
      this._assertGeneration(generation, `loading gene column ${index} of ${label}`);
      return result;
    }, signal, owner, keys);
  }

  /**
   * Many gene columns of one matrix at once, in the order asked: their reads
   * go out together, so the store fetches what they need as one set of
   * coalesced, parallel requests.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} genes
   * @param {{signal?: AbortSignal|null, owner?: string|null, keys?: string[]|null}} [options] -
   *   `signal` cancels the read; `owner` is the job it is for and `keys` the
   *   shared loads (as `getMatrixColumn`)
   * @returns {Promise<Float32Array[]>}
   */
  async getMatrixColumns(element, genes, { signal = null, owner = null, keys = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { label, nVars } = this._requireMatrixElement(element);
    const positions = requirePositions(genes, nVars, `${label} gene column`);
    return this._track(owner === null ? 'genes' : 'analysis', `${positions.length} genes of ${label}`, async readOptions => {
      const columns = await this._matrixColumns(element, generation, readOptions);
      const result = await Promise.all(positions.map(gene => columns.column(gene, readOptions)));
      this._assertGeneration(generation, `loading ${positions.length} gene columns of ${label}`);
      return result;
    }, signal, owner, keys);
  }

  /**
   * Many gene columns of one matrix as their non-zero entries
   * (`SparseColumn`: `{length, indices: Uint32Array, values: Float32Array}`,
   * each array owning its buffer), in the order asked: what an analysis
   * computes from, about 45 times fewer bytes than the dense column of a
   * median gene. The values are the dense column's, bit for bit. An
   * analysis's read (kind `analysis`): its job (`owner`) shows it.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} genes
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options] -
   *   `signal` cancels the read; `owner` is the job it reads for
   * @returns {Promise<Array<import('../sparse-column-index.js').SparseColumn>>}
   */
  async getMatrixColumnsSparse(element, genes, { signal = null, owner = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { label, nVars } = this._requireMatrixElement(element);
    const positions = requirePositions(genes, nVars, `${label} gene column`);
    return this._track('analysis', `${positions.length === 1 ? `gene ${positions[0]}` : `${positions.length} genes`} of ${label}`, async readOptions => {
      const columns = await this._matrixColumns(element, generation, readOptions);
      const result = await Promise.all(positions.map(gene => columns.sparseColumn(gene, readOptions)));
      this._assertGeneration(generation, `loading ${positions.length} gene columns of ${label}`);
      return result;
    }, signal, owner);
  }

  /**
   * The non-zero genes of cells (rows) of one matrix, in the order asked.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} cells
   * @param {{signal?: AbortSignal|null}} [options] - `signal` cancels the read
   * @returns {Promise<Array<{genes: Int32Array, values: Float32Array}>>}
   */
  async getMatrixRows(element, cells, { signal = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { label } = this._requireMatrixElement(element);
    const positions = requirePositions(cells, this._nObs, `${label} cell row`);
    const access = await this._matrixRows(element, signal);
    return this._track('cells', `${positions.length} cells of ${label}`, async readOptions => {
      // A CSR matrix reads nearby rows as one range; any other layout row by row.
      const result = access.rows !== undefined
        ? await access.rows(positions, readOptions)
        : await Promise.all(positions.map(cell => access.row(cell, readOptions)));
      this._assertGeneration(generation, `loading ${positions.length} cell rows of ${label}`);
      return result;
    }, signal);
  }

  /** The row access of one matrix, opened once and shared (`openMatrixRows`). @private */
  async _matrixRows(element, signal) {
    const { node, label, nVars } = this._requireMatrixElement(element);
    if (this._rows?.element !== element) {
      this._releaseRows();
      const rows = openMatrixRows(node, {
        format: this._format,
        label,
        nObs: this._nObs,
        nVars,
        indexOptions: this._indexOptions(),
        onIndexStart: indexLabel => this.createActivity?.({ kind: 'index', label: `${indexLabel}, indexed by cell`, background: true }) ?? null,
        inFlightEntries: this._inFlightEntries(),
      });
      rows.catch(() => {});
      this._rows = { element, rows };
    }
    const state = this._rows;
    try {
      return await untilAborted(state.rows, signal);
    } catch (error) {
      if (this._rows === state) this._rows = null;
      throw error;
    }
  }

  /**
   * Entries a long read keeps requested at once: two slabs read ahead, as
   * every streamed read does; over a slower link, at least what fills every
   * request the link runs at once. A scheduling choice, not a limit.
   * @private
   */
  _inFlightEntries() {
    const slabs = 2 * SLAB_BYTES;
    const link = this._readsAhead() ? null : this._link.snapshot();
    const bytes = link === null ? slabs : Math.max(slabs, link.maxRequestBytes * link.concurrency);
    return Math.floor(bytes / 8);
  }

  /**
   * The values of some genes in some cells of one matrix, as a gene-major
   * sparse block: gene `genes[g]` has the entries `pointers[g]` to
   * `pointers[g + 1]`, each at position `cellIndex[k]` of `cells` (ascending
   * within a gene) with value `values[k]`; a cell a gene does not list is
   * zero.
   *
   * Read by whichever costs less (`readCellSubset`), counted in the bytes
   * each decodes or copies: the cells' rows (a CSR or dense matrix: every
   * chunk the rows touch), or the genes' columns (a CSC matrix's ranges, or
   * a gene index's entries in memory, plus what is left of building it).
   * Few cells of a large matrix are read by cell; many, or any once the gene
   * index is built, by gene.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} cells - Distinct cell positions
   * @param {ReadonlyArray<number>} genes - Distinct gene positions
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options] -
   *   An analysis's read (kind `analysis`) for the job `owner`
   * @returns {Promise<{pointers: Float64Array, cellIndex: Int32Array, values: Float32Array}>}
   */
  async getMatrixCellSubset(element, cells, genes, { signal = null, owner = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { node, label, nVars } = this._requireMatrixElement(element);
    const cellPositions = requirePositions(cells, this._nObs, `${label} cell row`);
    const genePositions = requirePositions(genes, nVars, `${label} gene column`);
    for (const [positions, what] of [[cellPositions, 'cell'], [genePositions, 'gene']]) {
      if (new Set(positions).size !== positions.length) {
        throw new RangeError(`A cell subset of ${label} names a ${what} more than once`);
      }
    }
    const byCell = !isGroup(node) || sparseContract(node, this._format, `Sparse ${label}`).format === 'csr';
    return this._track('analysis', `${genePositions.length} genes in ${cellPositions.length} cells of ${label}`, async readOptions => {
      const [columns, rows] = await Promise.all([
        this._matrixColumns(element, generation, readOptions),
        byCell ? this._matrixRows(element, readOptions.signal) : null,
      ]);
      const { block } = await readCellSubset(columns, rows, cellPositions, genePositions, {
        nObs: this._nObs,
        label,
        inFlightEntries: this._inFlightEntries(),
        readOptions,
      });
      this._assertGeneration(generation, `loading ${genePositions.length} genes in ${cellPositions.length} cells of ${label}`);
      return block;
    }, signal, owner);
  }

  /** Whether the store's link delivers bytes as fast as a disk (see `open`). @private */
  _readsAhead() {
    return this._link === null || this._link.readsAhead;
  }

  /** Options of a background index (`RowMajorColumnIndex`), from the link as measured now. @private */
  _indexOptions() {
    const budget = residencyBudgetBytes('columnIndex');
    const readsAhead = this._readsAhead();
    const link = this._link;
    return {
      storeFactory: this.columnStoreFactory,
      // Read ahead (a link as fast as a disk), a sparse matrix is indexed
      // with its values, as a local file is, pass 1's indices (and values a
      // waiting gene made it read) kept for pass 2 within what the budget
      // leaves beside the store, saving a second decode of them; a gene is
      // then a copy out of the column store. Over a slower link the indices
      // are the index (values are read per gene, where genes need them), and
      // reading them again costs far more than keeping them, so the whole
      // budget is theirs.
      retainIndicesBytes: budget,
      valuesOnDemand: !readsAhead,
      // What a request costs on the link, for reading genes' value ranges.
      link: link === null ? null : () => link.snapshot(),
      yieldControl: waited => this._yieldToForeground(waited),
    };
  }

  /** Release row access and any index it holds. @private */
  _releaseRows() {
    const state = this._rows;
    this._rows = null;
    state?.rows.then(rows => (rows.retire ?? rows.dispose)?.(), () => {});
  }

  /**
   * Start indexing one expression matrix by gene in the background, when its
   * layout needs it (CSR) and the link reads ahead (see `open`), so the first
   * gene shown does not wait for the whole build. A dense matrix is not
   * indexed ahead: its index holds every value, as much memory as the matrix
   * itself (28,317 x 3,136 float32: 663 MB resident at open, for a dataset
   * whose genes may never be shown), so it is built when the first gene is
   * asked for (549 ms on that matrix, read from disk) and kept within the
   * column-index budget like any other. Returns at once; a failure reaches
   * the gene reads.
   */
  prepareMatrix(element) {
    this._ensureOpen();
    if (!this._readsAhead()) return;
    if (!isGroup(this._requireMatrixElement(element).node)) return;
    const generation = this._generation;
    this._matrixColumns(element, generation)
      .then(columns => columns.prepare?.())
      .catch(() => {});
  }

  /**
   * The state of one matrix, made the one read now (the last of
   * `_matrices`); switching matrices settles the others. @private
   */
  _matrixState(element) {
    let state = this._matrices.get(element);
    const switched = state === undefined || [...this._matrices.keys()].at(-1) !== element;
    if (state === undefined) state = { element, columns: null, loadPromise: null };
    this._matrices.delete(element);
    this._matrices.set(element, state);
    if (switched) this._settleMatrices();
    return state;
  }

  /**
   * Keep what the memory budget holds of the matrices read before the one
   * read now: an index still being built stops (its waiting genes are still
   * answered); built indexes stay, most recently read first, while they and
   * the current matrix's index fit `columnIndex`. @private
   */
  _settleMatrices() {
    const states = [...this._matrices.values()];
    const current = states.pop();
    let held = current.columns?.residentBytes?.() ?? 0;
    const budget = residencyBudgetBytes('columnIndex');
    for (const state of states.reverse()) {
      const built = state.columns !== null && state.columns.built?.() !== false;
      const bytes = state.columns?.residentBytes?.() ?? 0;
      if (built && held + bytes <= budget) {
        held += bytes;
      } else {
        this._releaseMatrixState(state);
      }
    }
  }

  /**
   * The column access of one matrix, opened once and shared: concurrent first
   * reads must not each start an index. Opening never takes a caller's
   * signal: every concurrent reader of the matrix waits on it, so one caller
   * cancelling must not fail the others.
   * @private
   */
  async _matrixColumns(element, generation, readOptions = {}) {
    const { node: matrix, label, nVars } = this._requireMatrixElement(element);
    const state = this._matrixState(element);
    if (state.columns) return state.columns;
    state.loadPromise ??= openMatrixColumns(matrix, {
      format: this._format,
      label,
      nObs: this._nObs,
      nVars,
      decodedChunkBytes: this._decodedChunkBytes,
      indexOptions: this._indexOptions(),
      onIndexStart: indexLabel => this.createActivity?.({ kind: 'index', label: `${indexLabel}, indexed by gene`, background: true }) ?? null,
      readOptions: { activity: readOptions.activity ?? null },
      pointers: this._pointerReads.get(element) ?? null,
    });
    const loadPromise = state.loadPromise;
    let columns;
    try {
      columns = await loadPromise;
    } catch (error) {
      // Pointers read ahead that failed are read again by the next attempt.
      this._pointerReads.delete(element);
      throw error;
    } finally {
      if (state.loadPromise === loadPromise) state.loadPromise = null;
    }
    this._assertGeneration(generation, `loading ${label}`);
    if (this._matrices.get(element) !== state) {
      // The matrix was let go while it opened: this read is still answered,
      // then the columns are let go.
      const once = read => async (index, options) => {
        try {
          return await read(index, options);
        } finally {
          (columns.retire ?? columns.dispose)?.();
        }
      };
      return { ...columns, column: once(columns.column), sparseColumn: once(columns.sparseColumn) };
    }
    if (state.columns === null) {
      // A failed read is not kept: the next read of this matrix starts over
      // (a transient read error must not stick to the dataset). A read its
      // caller cancelled did not fail: the access stays.
      const kept = read => async (index, options) => {
        try {
          return await read(index, options);
        } catch (error) {
          if (options?.signal?.aborted) throw error;
          if (this._matrices.get(element) === state && state.columns?.source === columns) {
            this._matrices.delete(element);
            columns.dispose?.();
          }
          throw error;
        }
      };
      state.columns = {
        ...columns,
        column: kept(columns.column),
        sparseColumn: kept(columns.sparseColumn),
        source: columns,
      };
    } else if (state.columns.source !== columns) {
      columns.dispose?.();
    }
    return state.columns;
  }

  /** Release one matrix and any index it holds. @private */
  _releaseMatrixState(state) {
    if (this._matrices.get(state.element) === state) this._matrices.delete(state.element);
    const columns = state.columns;
    state.columns = null;
    if (columns) (columns.retire ?? columns.dispose)?.();
  }

  /** Release every matrix and the indexes they hold; every release is tried. @private */
  _releaseMatrices() {
    const failures = [];
    for (const state of [...this._matrices.values()]) {
      try {
        this._releaseMatrixState(state);
      } catch (error) {
        failures.push(error);
      }
    }
    this._matrices.clear();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Releasing the matrix indexes failed');
  }

  /** The obs column `key`, checked to exist. @private */
  _obsColumn(key) {
    const obs = this._root.get('obs');
    if (!isGroup(obs) || !obs.has(key)) throw new Error(`Obs field '${key}' not found`);
    return obs;
  }

  /** Categories of one categorical field, read once per generation. @private */
  async _categories(categorical, key, generation, readOptions = {}) {
    const cacheKey = `obs_categories:${key}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const categories = await readCategories(categorical.categories, key, this._format, readOptions);
    this._assertGeneration(generation, `reading categorical labels for '${key}'`);
    if (!this._cache.has(cacheKey)) this._cache.set(cacheKey, categories);
    return this._cache.get(cacheKey);
  }

  /**
   * One obs field's type and (for categoricals) category count or labels,
   * without reading its values. @private
   */
  async _fieldInfo(key, { withCategories }) {
    this._ensureOpen();
    const cacheKey = withCategories ? `obs_info:${key}` : `obs_type:${key}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    if (!withCategories) return this._readFieldInfo(key, cacheKey, false, {});
    return this._track('field', `categories of obs['${key}']`, readOptions => this._readFieldInfo(key, cacheKey, true, readOptions));
  }

  /** @private */
  async _readFieldInfo(key, cacheKey, withCategories, readOptions) {
    const generation = this._generation;
    const format = this._format;
    const obs = this._obsColumn(key);
    const item = obs.get(key);
    const declared = validateColumnEncoding(item, format, `Observation field '${key}'`);
    const categorical = resolveCategoricalColumn(obs, key, format);
    let result;
    if (categorical) {
      validateCodes(categorical.codes, key, format, this._nObs);
      if (withCategories) {
        // The palette is read with the categories it colours, as metadata:
        // the first colouring, a legend or a restored session all need it
        // before any code is read.
        const [categories, colors] = await Promise.all([
          this._categories(categorical, key, generation, readOptions),
          readObsFieldColors(this._root, key, readOptions),
        ]);
        result = { dtype: 'categorical', categories, ordered: categorical.ordered, colors };
      } else {
        result = { dtype: 'categorical', categoryCount: categoryCount(categorical.categories, key, format), ordered: categorical.ordered };
      }
    } else if (NULLABLE_ENCODINGS.has(declared)) {
      const contract = nullableContract(item, key, declared, format, this._nObs);
      result = {
        dtype: declared === 'nullable-integer'
          ? (contract.valuesKind === 'uint' ? 'uint' : 'int')
          : (declared === 'nullable-boolean' ? 'bool' : 'string'),
      };
    } else {
      validateOneDimensional(item, format, `Observation field '${key}'`, this._nObs);
      result = { dtype: valueKind(item) };
    }
    this._assertGeneration(generation, `reading observation field metadata '${key}'`);
    this._cache.set(cacheKey, result);
    return result;
  }

  /** An obs field's type and categories, without its values. */
  getObsFieldInfo(key) {
    return this._fieldInfo(key, { withCategories: true });
  }

  /**
   * An obs field's type from its metadata alone, nothing read: a
   * categorical's `categoryCount` and `ordered`, not its categories (a
   * dictionary of one category per cell is megabytes, read when the field
   * is first loaded).
   */
  getObsFieldKind(key) {
    return this._fieldInfo(key, { withCategories: false });
  }

  /**
   * An obs field's values: categorical codes with their categories,
   * continuous values as float32, booleans and strings as values (null where
   * a nullable column is missing). `signal` cancels the read.
   */
  async getObsField(key, { signal = null } = {}) {
    this._ensureOpen();
    const cacheKey = `obs:${key}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    return this._track('field', `obs['${key}']`, readOptions => this._readObsField(key, cacheKey, readOptions), signal);
  }

  /** @private */
  async _readObsField(key, cacheKey, readOptions) {
    const generation = this._generation;
    const format = this._format;
    const obs = this._obsColumn(key);
    const item = obs.get(key);
    const declared = validateColumnEncoding(item, format, `Observation field '${key}'`);
    const categorical = resolveCategoricalColumn(obs, key, format);
    let result;
    if (categorical) {
      const count = categoryCount(categorical.categories, key, format);
      const [categories, codes] = await Promise.all([
        this._categories(categorical, key, generation, readOptions),
        readCodes(categorical.codes, count, key, format, this._nObs, readOptions),
      ]);
      result = {
        dtype: 'categorical',
        codes,
        categories,
        ordered: categorical.ordered,
        // Values are rarely needed (codes and categories are); computed once,
        // only when asked for.
        get values() {
          const computed = Array.from(codes, code => (code >= 0 ? categories[code] : null));
          Object.defineProperty(this, 'values', { value: computed, writable: false });
          return computed;
        },
      };
    } else if (NULLABLE_ENCODINGS.has(declared)) {
      result = await readNullableValues(item, key, declared, format, this._nObs, null, readOptions);
    } else {
      const label = `Observation field '${key}'`;
      const length = validateOneDimensional(item, format, label, this._nObs);
      const dtype = requirePrimitiveKind(item, label);
      if (!OBS_KINDS.includes(dtype)) throw new Error(`${label} uses an unsupported element type`);
      let values;
      if (dtype === 'float' || dtype === 'int' || dtype === 'uint') {
        values = await readFloat32(item, 0, length, label, readOptions);
      } else {
        const raw = await readStored(item, 0, length, label, readOptions);
        values = new Array(length);
        if (dtype === 'bool') {
          const message = `Observation field '${key}' contains a non-boolean value`;
          for (let i = 0; i < length; i++) values[i] = decodeAnnDataBoolean(raw[i], message);
        } else {
          for (let i = 0; i < length; i++) values[i] = raw[i];
        }
      }
      result = { dtype, values };
    }
    this._assertGeneration(generation, `reading observation field '${key}'`);
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Restore a category dictionary retained by the adapter after this reader's
   * caches were cleared; the immutable array is shared, not decoded again.
   */
  seedObsFieldCategories(key, categories, ordered) {
    this._ensureOpen();
    if (!Array.isArray(categories)) return;
    if (typeof ordered !== 'boolean') throw new Error(`Categorical field '${key}' ordered must be a boolean`);
    const categoriesKey = `obs_categories:${key}`;
    const infoKey = `obs_info:${key}`;
    if (!this._cache.has(categoriesKey)) this._cache.set(categoriesKey, categories);
    if (!this._cache.has(infoKey)) this._cache.set(infoKey, { dtype: 'categorical', categories, ordered });
  }

  /**
   * Hand one observation payload to the caller: the reader forgets it but
   * keeps the field's categories and type, so the payload can be transferred
   * out of the worker without leaving a detached buffer in this cache.
   */
  detachObsField(key, field) {
    const cacheKey = `obs:${key}`;
    if (this._cache.get(cacheKey) === field) this._cache.delete(cacheKey);
  }

  /** Release one cached observation payload (and category aliases the adapter keeps). */
  releaseObsField(key, expected = undefined) {
    const cacheKey = `obs:${key}`;
    const cached = this._cache.get(cacheKey);
    if (expected !== undefined && cached !== expected) return;
    this._cache.delete(cacheKey);
    const categories = cached?.dtype === 'categorical' ? cached.categories : null;
    if (!Array.isArray(categories)) return;
    const categoriesKey = `obs_categories:${key}`;
    if (this._cache.get(categoriesKey) === categories) this._cache.delete(categoriesKey);
    const infoKey = `obs_info:${key}`;
    const info = this._cache.get(infoKey);
    if (info?.dtype === 'categorical' && info.categories === categories) this._cache.delete(infoKey);
  }

  /**
   * One neighbour graph's metadata (`obsp[key]`), checked without reading
   * it, or null when `obsp` has no such key. @private
   */
  _connectivityMetadata(key) {
    this._ensureOpen();
    requireObspKey(key);
    const cacheKey = `connectivity:metadata:${key}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const format = this._format;
    let result = null;
    if (this._root.has('obsp')) {
      const obsp = requireMapping(this._root.get('obsp'), format, `${format.file} obsp mapping`);
      if (obsp.has(key)) {
        const conn = obsp.get(key);
        if (isGroup(conn)) {
          const sparse = sparseContract(conn, format, 'Connectivity matrix');
          if (sparse.shape[0] !== this._nObs || sparse.shape[1] !== this._nObs) {
            throw new Error(`Connectivity matrix shape ${sparse.shape[0]}×${sparse.shape[1]} does not match ${this._nObs} cells`);
          }
          result = { kind: 'sparse', node: conn };
        } else {
          validateArrayEncoding(conn, format, 'Dense connectivity matrix', 'array');
          const shape = shapeOf(conn, 'Dense connectivity matrix', 2);
          if (shape[0] !== this._nObs || shape[1] !== this._nObs) {
            throw new Error(`Connectivity matrix shape ${shape[0]}×${shape[1]} does not match ${this._nObs} cells`);
          }
          if (!isAnnDataMatrixDataKind(valueKind(conn))) throw new Error('Dense connectivity matrix must use a numeric dtype');
          result = { kind: 'dense', node: conn, shape };
        }
      }
    }
    this._cache.set(cacheKey, result);
    return result;
  }

  /** Whether `obsp[key]` holds a neighbour graph. */
  async hasConnectivities(key) {
    return this._connectivityMetadata(key) !== null;
  }

  /**
   * The edges of `obsp[key]`, checked and extracted here, beside the matrix
   * (in the reader worker), so the page never walks a large graph.
   */
  async getConnectivityEdges(key, options = {}) {
    const matrix = await this.getConnectivities(key, options);
    return this._inForeground(() => connectivityEdgesOf(matrix, this._nObs));
  }

  /** One neighbour graph, `obsp[key]`, read whole (not cached: its edges are). */
  async getConnectivities(key, { signal = null } = {}) {
    this._ensureOpen();
    const metadata = this._connectivityMetadata(key);
    if (metadata === null) return null;
    return this._track('graph', `obsp['${key}']`, readOptions => this._readConnectivities(metadata, readOptions), signal);
  }

  /** @private */
  async _readConnectivities(metadata, readOptions) {
    const generation = this._generation;
    let result;
    if (metadata.kind === 'dense') {
      const [nRows, nCols] = metadata.shape;
      // Every row, every column: a two-dimensional read, not a row range of
      // a one-dimensional array.
      const data = await metadata.node.read([[0, nRows], [0, nCols]], readOptions);
      result = { data, format: 'dense', shape: metadata.shape };
      if (!data || data.length !== nRows * nCols) throw new Error('Dense connectivity matrix payload length does not match its shape');
    } else {
      result = await readSparseMatrix(metadata.node, this._format, 'Connectivity matrix', 'exact', readOptions);
    }
    this._assertGeneration(generation, 'loading connectivity data');
    return result;
  }


  async getDatasetMetadata() {
    this._ensureOpen();
    const generation = this._generation;
    const probes = await this.probeMapping();
    let nCategorical = 0;
    let nContinuous = 0;
    for (const key of this._obsKeys) {
      const info = await this._fieldInfo(key, { withCategories: false });
      if (info.dtype === 'categorical') nCategorical++;
      else if (info.dtype === 'float' || info.dtype === 'int' || info.dtype === 'uint') nContinuous++;
    }
    // The graph a file opens with is obsp['connectivities'] (the data
    // mapping's default); any other is read only when it is chosen.
    const hasConnectivity = await this.hasConnectivities(DEFAULT_KNN_KEY);
    const title = await this._title;
    this._assertGeneration(generation, 'building dataset metadata');
    return {
      title,
      cellucid: this._cellucid,
      stats: {
        n_cells: this._nObs,
        n_genes: this.hasExpressionMatrix ? this._nVars : 0,
        n_obs_fields: this._obsKeys.length,
        n_categorical_fields: nCategorical,
        n_continuous_fields: nContinuous,
        has_connectivity: hasConnectivity,
      },
      probes,
      obs_fields: this._obsKeys.map(key => ({ key, kind: 'unknown' })),
    };
  }

  _ensureOpen() {
    if (this._closed || !this._root) throw new Error('No AnnData file is open. Call open() first.');
  }

  _assertGeneration(generation, operation = 'loading AnnData data') {
    if (this._closed || generation !== this._generation) {
      throw new Error(
        `${this._format?.file ?? 'AnnData'} dataset changed, cache was cleared, or file was closed while ${operation}; the request was superseded`
      );
    }
  }

  /** Drop every cached field, name list and matrix index. */
  clearCache() {
    this._generation++;
    this._cache.clear();
    // Row access is released even when releasing a matrix fails.
    try {
      this._releaseMatrices();
    } finally {
      this._releaseRows();
    }
  }

  _releaseCurrentState() {
    let failure = null;
    const record = error => {
      const exact = error instanceof Error ? error : new TypeError('AnnData resource release must reject with an Error.', { cause: error });
      failure = failure === null ? exact : combineDatasetLifecycleFailures(failure, exact, 'Multiple AnnData resources failed to release.');
    };
    if (this._store) {
      // A store whose close failed stays owned, so a later close retries it.
      try {
        this._store.close?.();
        this._store = null;
      } catch (error) {
        record(error);
      }
    }
    this._root = null;
    try {
      this.clearCache();
    } catch (error) {
      record(error);
    }
    this._nObs = 0;
    this._nVars = 0;
    this._obsKeys = [];
    this._varNames = [];
    if (failure !== null) throw failure;
  }

  /** Close the store and release everything held. */
  close() {
    if (this._closed && !this._root && !this._store) return;
    this._openRequestId++;
    this._closed = true;
    this._releaseCurrentState();
  }
}

