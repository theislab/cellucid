/**
 * The AnnData reader: one class that reads an AnnData dataset from an array
 * store (`formats/store.js`), whether the store is an `.h5ad` (HDF5) or an
 * AnnData Zarr store. It runs in the AnnData reader worker
 * (`anndata-reader-worker.js`); the main thread talks to it through
 * `AnnDataReaderClient` and never blocks on a file.
 *
 * Opening checks the dataset's structure from its metadata alone (a store's
 * tree is read as it is navigated into, `formats/store.js` `Group.load`, so
 * opening loads only the groups it checks), reading only the obs and var
 * indexes it needs.
 * A store of several modalities (`views/modalities.js`) adds one AnnData
 * group per modality: every expression read names its matrix by path
 * (`mod/<name>/X`), and a modality that measured only some cells is read
 * through its cell map.
 * Everything else is read when asked for, touching only what the request
 * needs: a field reads its arrays, a gene reads its column
 * (`matrix-access.js`), an embedding reads its columns.
 *
 * This module holds the reader's state and its lifecycle: the constructor
 * that declares every field, `open`, `_adopt` and the carry (which move
 * fields between readers), opening the cells and the structure (which write
 * them), clearing, trimming, releasing and closing (which reset them), and
 * the few helpers every part calls. Its other members are its method groups
 * (`reader/`, see `reader/README.md`), mixed onto its prototype at the end
 * of this module; the functions they share are modules of their own
 * (`uns.js`, `probe.js`, `cell-maps.js`, `positions.js`,
 * `cell-subset-blocks.js`, `present-categories.js`, `prefix-reads.js`).
 *
 * @module data/anndata/reader
 */

import { EmbeddingPayloads } from '../embedding-payload.js';
import { DecodedChunks } from './decoded-chunks.js';
import { isAnnDataMatrixDataKind } from '../anndata-value-kinds.js';
import {
  combineDatasetLifecycleFailures,
} from '../dataset-lifecycle-errors.js';
import { yieldToMacrotask } from '../../utils/yield-macrotask.js';
import { createWorkerColumnStoreFactory } from '../column-store-placement.js';
import { abortReason, awaitWithSignal, cancelled } from '../../utils/abort.js';
import { residencyBudgetBytes, setWorkingSet } from '../memory-budget.js';
import { isGroup } from '../../formats/store.js';
import {
  ANNDATA_OPENING_PATHS,
  AnnDataFormatError,
  attributeValue,
  child,
  encodingType,
  requireExactStringAttribute,
  requireMapping,
  shapeFromAttribute,
  shapeOf,
  validateArrayEncoding,
  validateDataFrame,
  valueKind,
} from './elements.js';
import {
  columnDefect,
  loadFrameStructure,
  readDataFrameIndex,
} from './dataframe.js';
import { sparseContract } from './sparse.js';
import { SLAB_BYTES, readIntegers } from './values.js';
import { currentLayoutView, isOlderAnnDataLayout } from './older-layouts.js';
import { cellMapOf, frameRows } from './views/modalities.js';
import { cellSubsetView, CellRows, estimatedChunkShare } from './views/cell-subset.js';
import { cellReadLayout, defaultExpressionPath, firstGeneReadCost, noteGeneSampleSeen, resolveCellSubset } from './subsample-plan.js';
import { firstViewCost, planProgressiveOpening } from './progressive-open.js';
import { createSubsampleCache } from '../subsample.js';
import {
  carriedSegments,
  PassRates,
} from './prefix-column-index.js';
import { PRIORITY_ORIGINAL_COLUMN } from './priority-layout.js';
import { keptIndexGroup, keptIndexPrefix, orderKey } from './kept-column-index.js';
import { plannedHostLink, pricingLink } from '../host-link-memory.js';
import { plannedLink } from '../../formats/io/link.js';
import { formatCountOf } from '../../utils/format-units.js';
import { readUnsCellucid, launchExpressionOf, readUnsTitle } from './uns.js';
import { prefixEndRow, startPrefixReads } from './prefix-reads.js';
import { applyMixin } from '../../utils/apply-mixin.js';
import { AnnDataReaderStoredOutlierMethods } from './reader/stored-outliers.js';
import { AnnDataReaderNameMethods } from './reader/names.js';
import { AnnDataReaderObsmMethods } from './reader/obsm.js';
import { AnnDataReaderFieldMethods } from './reader/fields.js';
import { AnnDataReaderGraphMethods } from './reader/graphs.js';
import { AnnDataReaderMappingProbeMethods } from './reader/mapping-probe.js';
import { AnnDataReaderMatrixRowMethods } from './reader/matrix-rows.js';
import { AnnDataReaderGeneColumnMethods } from './reader/gene-columns.js';
import { AnnDataReaderCellSubsetMethods } from './reader/cell-subset-reads.js';
import { AnnDataReaderGeneSampleMethods } from './reader/gene-sample.js';
import { AnnDataReaderKeptIndexMethods } from './reader/kept-indexes.js';
import { AnnDataReaderRowPointerMethods } from './reader/row-pointers.js';
import { AnnDataReaderMatrixMethods } from './reader/matrices.js';
import { AnnDataReaderGeneSegmentMethods } from './reader/gene-segments.js';

/**
 * Readers made in this thread, naming each one's working-set part of an open
 * subsample's rows (`CellRows`: the kept rows, their runs and inverse;
 * `memory-budget.js`): a reader closed after the next one opened clears its
 * own part only.
 */
let readersMade = 0;

/**
 * Reads one AnnData dataset. One instance reads one store; it lives in the
 * AnnData reader worker.
 */
export class AnnDataReader {
  constructor() {
    /** Every gene of the cells a run reads by their rows, kept for its later reads (`_keptCellSubset`). */
    this._cellSubsetGenes = null;
    /** What reading a run's cells by their rows costs, priced once (`_rowsCostOf`). */
    this._cellSubsetRowsCost = null;
    /** A run's cells checked once, for its later reads (`_checkedCells`). */
    this._cellSubsetChecked = null;
    /**
     * Whole decoded chunks the subsample view reads its kept rows through
     * (`decoded-chunks.js`): the store's, kept within its decoded-chunk
     * budget beside its own cache, carried to each opening of the same
     * store (a progressive opening's steps copy their added rows out of
     * chunks earlier steps decoded), let go with the store.
     * @type {DecodedChunks|null}
     */
    this._decodedChunks = null;
    /**
     * The decoded-chunk budget of an opening that has no shared one
     * (`open`'s `decodedChunkBytes`); null until a store is open.
     * @type {number|null}
     */
    this._decodedChunkBytes = null;
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
    /** What opening left out, and why (`notes`). @type {readonly string[]} */
    this._notes = Object.freeze([]);
    /** @type {Map<string, Object>} Field types, categories, names */
    this._cache = new Map();
    /**
     * How each categorical obs field read so far is coded (`_categoryCoding`),
     * by key: `{present: false}`, its stored dictionary; or `{present: true,
     * count, stored, labels, colors}`, the categories its open cells hold.
     * Kept by a clear of the cache (the page holds codes under it) and
     * carried to an opening grown or cut in place (`_takeCarried`): a column
     * is coded one way for the life of what the page shows.
     * @type {Map<string, Object>}
     */
    this._categoryCodings = new Map();
    /**
     * The expression matrices whose columns are read, and how each one's
     * columns are reached, least recently read first. The matrix read now
     * is the last; a built gene index of an earlier one is kept while every
     * kept index fits the `columnIndex` memory budget, so switching back to
     * it reads nothing again (`_settleMatrices`).
     * @type {Map<string, {element: string, columns: Object|null, load: import('../../utils/abort.js').SharedWork|null}>}
     */
    this._matrices = new Map();
    /**
     * The modalities of a multimodal store (`views/modalities.js`), by
     * name, each with its cell map, and the one it opens with; null for a
     * store of one feature space.
     * @type {Map<string, {modality: Object, cells: Function}>|null}
     */
    this._modalities = null;
    this._defaultModality = null;
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
     * Row access (one cell's genes) to one matrix at a time (the matrix
     * whose rows were read last).
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
    /**
     * The cells this reader presents (`subsample-plan.js`): every cell
     * (`kept` null), or a subsample, whose view (`views/cell-subset.js`)
     * is `_root`; `_fullRoot` is the store as stored, for what is read of
     * every cell (a field's representation in the subsample).
     * @type {(import('./subsample-plan.js').CellSubsetResolution & {rows: CellRows|null, keptValues: number|null})|null}
     */
    this._cellSubset = null;
    /** This reader's working-set part of its open subsample's rows. @private */
    this._cellRowsPart = `cell rows ${++readersMade}`;
    this._fullRoot = null;
    /**
     * Whether each 64-bit integer obs column holds identifiers past 2^53
     * among every cell of the dataset (`_holdsIdentifiers`), by key: decided
     * once, whatever cells are open.
     * @type {Map<string, Promise<boolean>>}
     */
    this._identifierColumns = new Map();
    /**
     * The expression matrix genes are read from by default, as a path below
     * the store root (`subsample-plan.js` `defaultExpressionPath`): what the
     * opening priced a gene by, and whose kept values it reports.
     * @type {string|null}
     */
    this._expression = null;
    /**
     * The prefix counts an opening of a priority-ordered file's first rows
     * reads as it opens (`startPrefixReads`), by matrix path.
     * @type {Map<string, Promise<{counts: Float64Array, levelRows: number}|null>>}
     */
    this._prefixReads = new Map();
    /**
     * The row pointers of the store's CSR matrices, by path, read whole:
     * they do not depend on the cells open, so another opening of the same
     * store takes them over (`open`'s `carry`). Counted with the gene
     * indexes they are read to build (`columnIndex`, `residentBytes`), let go
     * with them and read again when asked for.
     * @type {Map<string, Float64Array>}
     */
    this._indptrs = new Map();
    /** Kept rows' pointers an earlier subsample of the same store read (`cellSubsetView`). */
    this._knownRowPointers = new Map();
    /**
     * The first stored row pointers of CSR matrices whose open rows are the
     * file's (`_storedRowPointers`: a gene sample's), by path, until the
     * whole `indptr` is read (`_indptrs`).
     * @type {Map<string, Float64Array>}
     */
    this._indptrPrefixes = new Map();
    /**
     * Gene columns an earlier opening of the same store built that this
     * one's cells keep (`_takeCarried`), by matrix element, until the matrix
     * is first read: `{segments}` (a prefix of rows, `prefix-column-index.js`)
     * or `{columns}` (the same rows, the whole access).
     * @type {Map<string, {segments?: Array, columns?: Object}>}
     */
    this._carried = new Map();
    /**
     * Where the gene indexes of this store's cell-major matrices are kept in
     * this browser across visits (`kept-column-index.js`): `{identity, tab,
     * onStore, environment}`, the bytes' identity (`openDatasetStore`); null
     * keeps none.
     * @type {{identity: Object, about?: {name: string|null, host: string|null}|null, tab?: string, onStore?: ((store: {directory: string, state: string}) => (void|Promise<void>))|null, environment: Object}|null}
     */
    this._keptIndexes = null;
    /** What the opening's host delivered on earlier visits (`host-link-memory.js`), or null. */
    this._hostLink = null;
    /** Store rows holding their matrix rows when not every one does (`open`'s `held`). */
    this._held = null;
    /**
     * With `held`, a progressive opening's (`growth`): the store rows the
     * first `held.fitCells` cells it grows to lie in, which the one pass
     * over its matrix keeps (`shareRows`); null otherwise.
     * @type {number|null}
     */
    this._grownShareRows = null;
    /**
     * The subsamples this opening resolves, ranked once (`subsample.js`
     * `createSubsampleCache`): carried to each opening of the same bytes (a
     * progressive opening's steps, Apply), so each size of one subsample
     * ranks no cell again; let go on close.
     * @type {ReturnType<typeof import('../subsample.js').createSubsampleCache>|null}
     */
    this._subsampleCache = null;
    /**
     * The cells earlier openings of these bytes opened, each with its cell
     * order and the gene sample it read them for (`noteGeneSampleSeen`):
     * carried to each opening of the same bytes.
     * @type {Map<string, Object>}
     */
    this._geneSamplesSeen = new Map();
    /**
     * The kept runs of each matrix's index found for this opening and not
     * yet taken by its index (`_keptRunsOf`), by matrix element.
     * @type {Map<string, Promise<import('./kept-column-index.js').KeptRun[]>>}
     */
    this._keptRuns = new Map();
    /**
     * Open rows of a matrix in store order (`_storeOrderMatrix`), made for
     * the check of a run kept in store order and not yet taken by the
     * segment that uses them, by matrix element and rows.
     * @type {Map<string, Promise<{order: Uint32Array, matrix: Object, pointers: Float64Array}>>}
     */
    this._storeOrdered = new Map();
    /** @type {Set<Promise<void>>} Runs of built indexes being kept (`_keepRun`). */
    this._keeping = new Set();
    /**
     * The directory each run kept by this opening was kept in, by matrix and
     * rows (`_keepRun`): a run kept again of the same rows replaces it.
     * @type {Map<string, Object>}
     */
    this._keptRunDirectories = new Map();
    /**
     * The prefix counts of each level of a priority-ordered file's
     * gene-major X, read once per opening (`_prefixLevelCounts`), by matrix
     * and level.
     * @type {Map<string, Promise<Object|null>>}
     */
    this._levelCounts = new Map();
    /**
     * What reading a matrix by its rows costs, priced once per merge gap
     * (`_readsNoMoreThanRows`), by matrix node.
     * @type {WeakMap<Object, {mergeGapBytes: number, valuesOnDemand: boolean, cost: Object|null}>}
     */
    this._rowsCosts = new WeakMap();
    /**
     * Whether each matrix indexed in segments reads its genes through every
     * stored row's index restricted to the open rows (`_restrictsWhole`),
     * decided once per opening, by matrix element.
     * @type {Map<string, Promise<boolean>>}
     */
    this._restricted = new Map();
    /**
     * What the work of a gene index pass measured on this store costs
     * (`PassRates`): carried to every opening of the same store, it weighs a
     * share's pass against every stored row's (`_restrictsWhole`).
     */
    this._passRates = new PassRates();
    /**
     * How much of each neighbor graph read the subsample keeps
     * (`subsampleGraphShare`), by `obsp` key.
     * @type {Map<string, {kept: number, of: number}>}
     */
    this._graphShares = new Map();
    this._generation = 0;
    this._openRequestId = 0;
    this._closed = false;
    /** Where gene-column indexes are kept (memory, else disk). */
    this.columnStoreFactory = createWorkerColumnStoreFactory();
    /**
     * Makes the activity (`formats/io/activity.js`) one operation reads
     * under, so what each read fetched and decoded is counted and reported;
     * null counts nothing.
     * @type {((what: {kind: string, label: string, owner?: string|null, keys?: string[]|null, background?: boolean}) => import('../../formats/io/activity.js').ReadActivity)|null}
     */
    this.createActivity = null;
    /** The running read of a matrix's open rows' pointers, by element (`_readyRows`). */
    this._pointerActivities = new Map();
    /**
     * Embedding and vector-field payloads made from `obsm` columns
     * (`embedding-payload.js`), forgotten whenever the caches are cleared.
     */
    this._payloads = new EmbeddingPayloads(
      (key, columns, options) => this.readObsmColumns(key, columns, options),
      {
        cellCount: () => this._nObs,
        cellNames: cells => this._cellNames(cells),
        generation: () => this._generation,
        // What the cell-order digest names each open cell by (`cell-identity.js` `originalAt`).
        originals: () => this._cellSubset?.openOrder ?? this._cellSubset?.kept ?? null,
      }
    );
  }

  /**
   * Load the elements at `paths` below the open root (`formats/store.js`,
   * `Group.load`): what a reading navigates beyond what opening loaded
   * (`ANNDATA_OPENING_PATHS`), each object read once however many readings
   * ask, under the reading's own signal and activity.
   */
  _ready(paths, readOptions = {}) {
    return this._root.load(paths, { signal: readOptions.signal ?? null, activity: readOptions.activity ?? null });
  }

  /**
   * Run `operation(readOptions)` under one activity of `kind` named `label`,
   * read for the job `owner` (if any), finished with the outcome. `signal`
   * cancels it: its reads stop, and so does any wait on shared work.
   */
  async _track(kind, label, operation, signal = null, owner = null, keys = null) {
    const activity = this.createActivity?.({ kind, label, owner, keys }) ?? null;
    try {
      if (signal?.aborted) throw abortReason(signal);
      const result = await awaitWithSignal(operation({ activity, signal }), signal);
      activity?.finish();
      return result;
    } catch (error) {
      activity?.finish(error);
      throw error;
    }
  }

  /** Run `work` as an operation someone waits for (see `_yieldToForeground`). */
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
   * index's work is the reader thread's, so a graph's extraction running
   * beside it takes turns with it and takes longer. Reads are not counted:
   * one may wait for the index itself.
   */
  async _yieldToForeground(waited) {
    await yieldToMacrotask();
    while (!waited && this._foreground > 0) {
      await new Promise(resolve => this._foregroundIdle.push(resolve));
    }
  }

  /** Refuse an opening a later `open` or `close` superseded. @private */
  _assertOpenRequest(requestId) {
    if (requestId !== this._openRequestId) {
      throw cancelled('superseded', `${this._format?.file ?? 'AnnData'} open request was superseded or closed.`);
    }
  }

  /**
   * Open one store.
   *
   * @param {Object} store - An opened store root (`openHdf5` / `openZarr`), with `close()`
   * @param {{format: import('./elements.js').AnnDataFormat, name: string, decodedChunkBytes?: number,
   *   decodedBudget?: import('../../formats/io/decoded-budget.js').DecodedBudget|null,
   *   link?: import('../../formats/io/link.js').LinkMeter|null,
   *   activity?: import('../../formats/io/activity.js').ReadActivity|null,
   *   cellSubset?: Object|null, carry?: AnnDataReader|null,
   *   keptIndexes?: {identity: Object, about?: {name: string|null, host: string|null}|null, tab?: string, onStore?: ((store: {directory: string, state: string}) => (void|Promise<void>))|null, environment?: Object}|null,
   *   hostLink?: Object|null, held?: {rows: number, fitCells: number, bytes: number}|null,
   *   drawn?: boolean, signal?: AbortSignal|null}} options
   *   `cellSubset`: the cells to open (`subsample-plan.js` `resolveCellSubset`);
   *   every cell when null.
   *   `hostLink`: what the opening's host delivered on earlier visits
   *   (`host-link-memory.js`).
   *   `decodedBudget`: the byte budget the store's own decoded-chunk cache
   *   charges (`openDatasetStore`), which the whole chunks a subsample's
   *   rows are read through share (`decoded-chunks.js`); without one they
   *   keep `decodedChunkBytes` of their own.
   *   `link`: the link to the store, measured as it is read (`openDatasetStore`).
   *   Over a link that delivers bytes as fast as a disk (`link.readsAhead`), a
   *   cell-major matrix is indexed by gene as soon as it is prepared, values
   *   with the structure, as a local file is; over a slower one, the index
   *   waits for the first gene and reads values only where genes need them,
   *   so opening downloads nothing a view has not asked for. A store without
   *   a link (one built in memory) has nothing between it and the reader and
   *   is read ahead.
   *   `activity`: the activity that opening the store started, which reading
   *   the AnnData structure continues (else it gets its own).
   *   `carry`: the reader of an earlier opening of the same store (other
   *   cells of it, read again in place): what it read that does not depend
   *   on the cells (row pointers, a CSC matrix's column pointers), and the
   *   gene indexes of the rows both openings share, are taken over
   *   (`_takeCarried`) instead of read again; an opening grown or cut in
   *   place keeps its embeddings' frame (`EmbeddingPayloads.adoptTransforms`).
   *   Only the same store is carried (the same version of the same file:
   *   `anndata-reader-worker.js`): an opening of a store that could not be
   *   taken over is read anew, frame and all. `signal` stops the opening.
   *   `keptIndexes`: `{identity, about?, tab?, onStore?, environment?}`, what
   *   the store's bytes are (`openDatasetStore`'s `identity`): the gene
   *   indexes of its cell-major matrices are kept in this browser under it
   *   and found again by a later opening of the same cells
   *   (`kept-column-index.js`); `about`: what the file is for the Session
   *   panel's list of what is kept (`space.js` `keptAbout`);
   *   `onStore({directory, state})` hears each kept directory as it is
   *   written and completed (the page holds it for the tab's life).
   *   `held`: `{rows, fitCells, bytes}` when only rows `[0, rows)` of the
   *   store hold their matrix rows (a matrix read after its map,
   *   `transcode/matrix-market.js`): the gene sample never reaches past
   *   them (`subsample-plan.js` `geneSampleOf`), nor does a growth
   *   (`growGeneSample`); `fitCells` the share sized to this device and
   *   `bytes` the matrix's, for what the page says of it.
   *   `drawn`: the opening is to be drawn (the app's): a store whose `obsm`
   *   holds no array of cell coordinates is refused before its cells are
   *   resolved (`_requireEmbedding`).
   */
  async open(store, { format, name, decodedChunkBytes = residencyBudgetBytes('decodedBlocks'), decodedBudget = null, link = null, activity = null, cellSubset = null, carry = null, keptIndexes = null, hostLink = null, held = null, drawn = false, signal = null }) {
    if (!isGroup(store)) throw new TypeError('An AnnData reader opens a store root group.');
    const requestId = ++this._openRequestId;
    const candidate = new AnnDataReader();
    candidate._format = format;
    candidate._name = name;
    candidate._store = store;
    candidate._decodedChunkBytes = decodedChunkBytes;
    // The link plans read: the source's, as measured, or as the machine's
    // link is held (`link.js` `plannedLink`). Its requests are measured and
    // shaped by the source's own meter either way.
    candidate._link = plannedLink(link);
    // What the host delivered on earlier visits: the link sizing prices at
    // until this one's own reads measure more (`host-link-memory.js`).
    candidate._hostLink = plannedHostLink(hostLink);
    candidate._held = held;
    candidate._keptIndexes = keptIndexes?.identity == null ? null : {
      identity: keptIndexes.identity,
      about: keptIndexes.about ?? null,
      // Kept for one tab only (an identity naming no version): the page's tab.
      tab: keptIndexes.tab ?? undefined,
      onStore: keptIndexes.onStore ?? null,
      environment: keptIndexes.environment ?? globalThis,
    };
    candidate.createActivity = this.createActivity;
    try {
      // A file written before anndata 0.8 is read through its current-layout
      // view; everything below reads one layout.
      candidate._root = isOlderAnnDataLayout(store) ? await currentLayoutView(store, { signal, activity }) : store;
      // The store's decoded chunks (`decoded-chunks.js`): an opening of the
      // same store (a growth's next step) reads its added rows out of them,
      // holding them beside the earlier opening (several may be live at
      // once: a reopen in flight while another commits), so they go only
      // once the last opening holding them closes.
      candidate._decodedChunks = carry?._decodedChunks?.retain() ?? new DecodedChunks(decodedBudget ?? decodedChunkBytes);
      // The subsamples the earlier opening of these bytes ranked: a growth's
      // next step takes its cells from them (`resolveCellSubset`).
      candidate._subsampleCache = carry?._subsampleCache ?? createSubsampleCache();
      // The cells the earlier openings of these bytes opened, each with its
      // cell order and the gene sample it read them for (the gene time's,
      // grown to fill it, or a person's): the same cells opened again -- a
      // share lowered and raised back -- read genes for that sample in that
      // order (`noteGeneSampleSeen`), not for one fitted again over the
      // link as measured this moment (which can read every cell of a huge
      // store after a round trip, and its gene index past the memory:
      // 23_decisions_partial_reading.md).
      candidate._geneSamplesSeen = new Map(carry?._geneSamplesSeen ?? []);
      if (carry?._cellSubset != null) noteGeneSampleSeen(candidate._geneSamplesSeen, carry._cellSubset);
      if (carry !== null) {
        // What its index passes measured (`PassRates`): the rates are the source's.
        candidate._passRates = carry._passRates;
        for (const [path, pointers] of carry._indptrs) candidate._indptrs.set(path, pointers);
        for (const [path, pointers] of carry._indptrPrefixes) candidate._indptrPrefixes.set(path, pointers);
        // The kept rows' pointers its subsample read: a raise or a lowering
        // of the same store reads only the rows they do not hold.
        candidate._knownRowPointers = carry._root?.knownRowPointers?.() ?? new Map();
        for (const [element, pointers] of carry._pointerReads) {
          if (!element.startsWith('mod/')) candidate._pointerReads.set(element, pointers);
        }
        // What was read of the store whatever its cells: the gene names of
        // each var axis (the var index among them), and each categorical
        // field's counts over every cell
        // (`subsampleRepresentation`). A progressive opening reopens at each
        // step; these are not read again.
        for (const [key, value] of carry._cache) {
          if (key.startsWith('var_names:') || key.startsWith('obs_counts:')) candidate._cache.set(key, value);
        }
      }
      const structure = async options => {
        // What opening reads of the store's tree (`ANNDATA_OPENING_PATHS`);
        // the rest loads when a reading needs it (`_ready`), never before.
        await candidate._ready(ANNDATA_OPENING_PATHS, options);
        // A root that is no AnnData store is refused as one first, not for
        // a part it would have (an embedding).
        candidate._requireAnnDataRoot();
        // An opening to be drawn of a store with nothing to draw is refused
        // here, before its cells are resolved (pricing them reads the
        // matrix's structure).
        if (drawn) await candidate._requireEmbedding(options);
        await candidate._openCells(cellSubset, options);
        // The open cells' original positions (a priority-ordered file) are
        // read beside the structure, not before it.
        await Promise.all([candidate._readStructure(options, carry), candidate._settleOpenOrder()]);
      };
      if (activity === null) {
        await candidate._track('open', `the structure of ${name}`, structure, signal);
      } else {
        await structure({ activity, signal });
      }
      // A cancelled opening takes nothing over from the earlier one, even
      // when a read of it did not stop.
      if (signal?.aborted) throw abortReason(signal);
      this._assertOpenRequest(requestId);
      const shared = carry === null ? 0 : candidate._sharedRows(carry);
      if (carry !== null) candidate._takeCarried(carry, shared);
      this._adopt(candidate);
      // An opening grown or cut in place -- its first cells are all of the
      // earlier one's, or its cells are all among the earlier one's first --
      // shows every embedding in the frame those cells were shown in, so
      // none of them moves (`EmbeddingPayloads.adoptTransforms`).
      // The same cells in another order (a subsample grown from few chunks
      // put in priority order, `progressive-open.js`) keep it likewise.
      const sameCells = carry !== null && this._sameCells(carry);
      if (carry !== null && ((shared > 0 && shared === Math.min(carry._nObs, this._nObs)) || sameCells)) {
        this._payloads.adoptTransforms(carry._payloads);
      }
      // The cell-order sums of the rows both openings share are kept,
      // whatever the frame (`EmbeddingPayloads.adoptCellOrderSums`).
      if (carry !== null) this._payloads.adoptCellOrderSums(carry._payloads, { shared, sameCells });
      const subset = this._cellSubset;
      console.log(`[AnnDataReader] Opened ${name}: ${formatCountOf(this._nObs, 'cell')}${subset?.kept ? ` of ${subset.nObs}` : ''}, ${formatCountOf(this._nVars, 'gene')}`);
    } catch (error) {
      let terminal = error instanceof Error && error.message.length > 0
        ? error
        : new TypeError(`${format.file} opening must reject with a non-empty Error.`, { cause: error });
      try {
        candidate._store = null;
        // Its hold on the decoded chunks goes; the earlier opening keeps its own.
        candidate.close();
      } catch (cleanupFailure) {
        terminal = combineDatasetLifecycleFailures(terminal, cleanupFailure, `${format.file} opening and candidate cleanup both failed.`);
      }
      throw terminal;
    }
  }

  /**
   * Make `candidate` (a reader that opened the store) this reader: what this
   * reader held is released, the candidate's opening is taken over field by
   * field, and the candidate keeps nothing it would close. @private
   */
  _adopt(candidate) {
    // This reader's hold on its decoded chunks goes; the candidate's becomes its own.
    this._decodedChunks?.release();
    this._decodedChunks = null;
    this._releaseCurrentState();
    for (const key of ['_root', '_store', '_format', '_name', '_nObs', '_nVars', '_obsKeys', '_notes', '_cache', '_matrices', '_decodedChunkBytes', '_title', '_cellucid', '_link', '_pointerReads', '_modalities', '_defaultModality', '_cellSubset', '_expression', '_fullRoot', '_indptrs', '_indptrPrefixes', '_knownRowPointers', '_carried', '_graphShares', '_prefixReads', '_keptIndexes', '_keptRuns', '_decodedChunks', '_hostLink', '_held', '_grownShareRows', '_subsampleCache', '_geneSamplesSeen', '_cellRowsPart', '_categoryCodings', '_restricted', '_passRates']) {
      this[key] = candidate[key];
    }
    this._closed = false;
    candidate._root = null;
    candidate._fullRoot = null;
    candidate._store = null;
    candidate._decodedChunks = null;
  }

  /** The file row of open cell `i` (every row in file order when no subset is open). @private */
  _fileRowAt(i) {
    const rows = this._cellSubset?.fileRows ?? null;
    return rows === null ? i : rows[i];
  }

  /**
   * Take over from `previous` (an earlier opening of the same store, about
   * to close) the gene columns of the dataset's own matrices that this
   * opening's cells keep: open rows `[0, L)` are the same file rows in both
   * (`L` their shared prefix; a larger or smaller subsample of the same
   * method and seed shares all of the smaller one, `priorityOrder`). A
   * matrix indexed in segments (`prefix-column-index.js`) keeps the segments
   * within `L`; one indexed whole is kept when both open the same rows.
   * What is not kept is `previous`'s to release. `shared` is `L`. @private
   */
  _takeCarried(previous, shared) {
    const nPrevious = previous._nObs;
    const sameRows = shared === nPrevious && shared === this._nObs;
    // Cells grown or cut in place (or the same cells in another order) stay
    // shown with the codes the page holds: each categorical keeps its coding
    // (`_categoryCoding`). Other cells are a new reading, coded anew.
    if ((shared > 0 && shared === Math.min(nPrevious, this._nObs)) || this._sameCells(previous)) {
      this._categoryCodings = new Map(previous._categoryCodings);
    }
    for (const [element, state] of [...previous._matrices]) {
      const columns = state.columns?.source ?? null;
      if (columns === null || element.startsWith('mod/')) continue;
      if (Array.isArray(columns.segments) && this._cellSubset?.ordered === true && previous._cellSubset?.ordered === true) {
        // Within the rows this opening reads genes for (its gene sample).
        const rows = Math.min(shared, this._cellSubset?.genes?.cells ?? shared);
        if (rows === 0) continue;
        previous._matrices.delete(element);
        this._carried.set(element, { segments: carriedSegments(columns, rows) });
      } else if (sameRows) {
        previous._matrices.delete(element);
        this._carried.set(element, { columns });
      }
    }
  }

  /**
   * Whether this opening and `previous` (an earlier opening of the same
   * dataset) open the same cells, in any order. @private
   */
  _sameCells(previous) {
    const mine = this._cellSubset?.kept ?? null;
    const theirs = previous._cellSubset?.kept ?? null;
    if (this._nObs !== previous._nObs || mine === null || theirs === null || mine.length !== theirs.length) return false;
    for (let i = 0; i < mine.length; i++) if (mine[i] !== theirs[i]) return false;
    return true;
  }

  /**
   * How many of the first open rows this opening and `previous` (an earlier
   * opening of the same dataset) share: the largest `L` such that open rows
   * `[0, L)` are the same file rows in both. @private
   */
  _sharedRows(previous) {
    const limit = Math.min(previous._nObs, this._nObs);
    let shared = 0;
    while (shared < limit && previous._fileRowAt(shared) === this._fileRowAt(shared)) shared++;
    return shared;
  }

  /**
   * `estimatedChunkShare` of the expression matrix genes are read from
   * (`_expression`), when it is CSR, for the kept rows (null for another
   * layout). @private
   */
  _estimatedChunkShare(full, resolution, rows = null) {
    const X = this._expression === null ? null : child(full, this._expression);
    if (!isGroup(X) || encodingType(X) !== 'csr_matrix') return null;
    const indices = X.get('indices');
    const chunkElements = Array.isArray(indices?.chunks) && indices.partialChunks !== true ? indices.chunks[0] : null;
    if (chunkElements === null) return null;
    // Every row open (in another order): every chunk, no rows ascending made for it.
    if (resolution.fileRows.length === resolution.nObs) return estimatedChunkShare(resolution.fileRows, resolution.nObs, indices.shape[0], chunkElements);
    // Over the open rows ascending, made once (`CellRows` `ascending`: a gene read weighs them again, `_restrictsWhole`).
    return estimatedChunkShare(rows?.ascending().kept ?? resolution.fileRows, resolution.nObs, indices.shape[0], chunkElements);
  }

  /** The link's merge gap now (0 without a link): what the subsample view joins reads within. */
  _mergeGapBytes() {
    return this._link?.mergeGapBytes ?? 0;
  }

  /**
   * Resolve which cells to open (`resolveCellSubset`) and, for a subsample,
   * present the store as its view (`cellSubsetView`): everything after
   * this reads the kept cells only. @private
   */
  async _openCells(request, readOptions) {
    const full = this._root;
    // The matrix genes are read from by default: what a gene costs is its
    // cost (`defaultExpressionPath`), decided once on the stored root. It is
    // decided here, before the cells are resolved, because it prices the
    // opening: the gene sample (`geneSampleOf`: gene time, gene index), the
    // default block size, which fixes every cell's open order (`cellOrder`),
    // and the map's memory fit (`autoFitCount`). Deciding it after the first
    // view would change the open cells and their order (a reopen). So the
    // read it may make -- the first chunk of a dense float `X` beside a
    // `raw` of the same genes, whether `X` is scaled -- is the one matrix
    // read an opening makes; every other probe of a matrix (whether it
    // holds counts) waits until after the first view (`probeMapping`), and a
    // served store answers that chunk at once while it lays the matrix out.
    this._expression = await defaultExpressionPath(full, { launch: await launchExpressionOf(full, readOptions) });
    // Opening loads every expression matrix (`ANNDATA_OPENING_PATHS`); a
    // launch default may name another element, priced here.
    if (this._expression !== null) await full.load([this._expression], readOptions);
    const context = {
      expression: this._expression,
      valuesOnDemand: !this._readsAhead(),
      decodedChunkBytes: this._decodedChunkBytes,
      readOptions,
      // Auto-fit prices the first gene of a matrix stored cell by cell at
      // the link as measured now, or as the host delivered on earlier visits
      // while this opening's reads rest on less (`host-link-memory.js`).
      link: pricingLink(this._link?.snapshot?.() ?? null, this._hostLink ?? null),
      // What a `blocks` order's rung is sized at, the opening's own rate
      // being a lower bound (`blockRung`): the rate the host sustained on
      // earlier visits, or this browser's downlink measured on the page's
      // assets (`host-link-memory.js` `hostLinkSeed`).
      seedBytesPerMs: Math.max(this._hostLink?.downlinkBytesPerMs ?? 0, this._hostLink?.bytesPerMs ?? 0) || null,
      // The first open cells whose gene index of that matrix is kept in
      // this browser cost the first gene only what the kept runs lack: their
      // values, when the runs hold entry positions alone (`keptIndexPrefix`).
      // Store rows holding their matrix rows, when not every one does.
      held: this._held ?? null,
      keptIndexRows: this._keptIndexes === null || this._expression === null ? null : (spec, shape) => keptIndexPrefix(keptIndexGroup({
        file: this._keptIndexes.identity,
        element: this._expression,
        shape,
        order: orderKey(spec, true),
      }), { environment: this._keptIndexes.environment, tab: this._keptIndexes.tab }),
      // The cells asked for are resolved first, then a progressive opening's
      // first view and each step after: every size of the subsample from
      // the one rank pass made for the largest (`subsample.js`).
      subsampleCache: this._subsampleCache,
      geneSamplesSeen: this._geneSamplesSeen,
    };
    let resolution = await resolveCellSubset(full, request, context);
    // A first view smaller than the cells asked for, when reading them is
    // measured to take long (`progressive-open.js`): the page grows it in
    // place to them (`growth`).
    let growth = null;
    if (request?.progressive != null) {
      const nObs = resolution.nObs;
      const link = pricingLink(this._link?.snapshot?.() ?? null, this._hostLink ?? null);
      const asked = resolution;
      const plan = await planProgressiveOpening(asked, {
        nObs,
        // Decoding is priced at a measured rate: before any chunk has been
        // decoded here, the first view's first chunk is read to measure it
        // where a read costs no round trip worth pricing.
        costOf: target => firstViewCost(full, nObs, asked.fileRows ?? null, target, readOptions, { measureDecode: link?.readsAhead === true }),
        link,
        msPerCell: request.progressive.msPerCell ?? null,
        targetMs: request.progressive.targetMs,
      });
      if (plan !== null) {
        resolution = await resolveCellSubset(full, plan.first, context);
        growth = plan.growth;
        // A matrix read after its map is read in one pass for the cells
        // the opening grows to, not for each step's (`shareRows`).
        if (this._held != null) this._grownShareRows = prefixEndRow(asked.fileRows ?? null, Math.min(growth.target, this._held.fitCells));
      }
    }
    this._fullRoot = full;
    if (resolution.fileRows === null) {
      this._cellSubset = { ...resolution, rows: null, keptValues: null, matrixChunkShare: null, readLayout: cellReadLayout(full, resolution.nObs, this._expression), growth };
      this._noteRowsHeld();
      return;
    }
    // The view reads a CSR matrix's row pointers when the matrix is first
    // read, and only the kept rows' (`readRowPointers`): opening a
    // subsample reads none. Pointers read whole before (every cell open,
    // then a subsample of the same store) serve it at once.
    // The open cells' rows and the lookups made of them (their runs, their
    // inverse), one set shared by the view and this reader, held while the
    // cells are open: counted in the working set (no cache gives them back).
    const rows = new CellRows(resolution.fileRows, resolution.nObs, { onHeld: (_bytes, made) => this._noteRowsHeld(made) });
    this._root = await cellSubsetView(full, {
      nObs: resolution.nObs,
      kept: resolution.fileRows,
      rows,
      mergeGapBytes: () => this._mergeGapBytes(),
      readOptions,
      indptrs: this._indptrs,
      knownRowPointers: this._knownRowPointers,
      chunks: this._decodedChunks,
      meter: this._passRates.view,
    });
    this._prefixReads = startPrefixReads(full, resolution, readOptions);
    this._cellSubset = {
      ...resolution,
      rows,
      // The stored values of the kept rows of a CSR X, known once X's kept
      // row pointers are read (`_readyRows`); the share of its index chunks
      // they lie in, estimated from its mean values a row until then (null
      // for another layout, or one read byte by byte).
      keptValues: null,
      matrixChunkShare: this._estimatedChunkShare(full, resolution, rows),
      // What a share of the cells costs of the arrays read most, by method (`cellShareReadShare`).
      readLayout: cellReadLayout(full, resolution.nObs, this._expression),
      growth,
    };
    this._noteRowsHeld();
  }

  /**
   * Count in this thread's working-set part what the open cells' rows (their
   * kept rows, runs and inverse), the subset's open order and the subsample
   * cache hold, each buffer once (the kept rows are often the cache's
   * selection). `rows`: the rows
   * being made, before `_cellSubset` names them. @private
   */
  _noteRowsHeld(rows = this._cellSubset?.rows ?? null) {
    const buffers = this._subsampleCache?.buffers() ?? new Set();
    for (const buffer of rows?.buffers() ?? []) buffers.add(buffer);
    // The subset's own per-cell arrays (its kept cells, its open order).
    for (const value of Object.values(this._cellSubset ?? {})) {
      if (ArrayBuffer.isView(value) && value.byteLength > 0) buffers.add(value.buffer);
    }
    let bytes = 0;
    for (const buffer of buffers) bytes += buffer.byteLength;
    setWorkingSet(this._cellRowsPart, bytes);
  }

  /**
   * Settle a priority-ordered file's open order (`openOrderRead`,
   * `subsample-plan.js`) into the cell subset. @private
   */
  async _settleOpenOrder() {
    const subset = this._cellSubset;
    const read = subset?.openOrderRead;
    if (read === undefined) return;
    const openOrder = await read;
    const { openOrderRead: _settled, ...rest } = subset;
    this._cellSubset = { ...rest, openOrder };
    this._noteRowsHeld();
  }

  /**
   * The cells this reader presents: `{nObs, kept, spec, autoFit,
   * reproduced, note, keptValues, matrixChunkShare}` (`subsample-plan.js`);
   * `kept` null when every cell is open. `keptValues` is the stored values
   * of the kept rows of a cell-major `X` (what its gene index holds), and
   * `matrixChunkShare` the share of its stored chunks they lie in; null for
   * other layouts.
   */
  get cellSubset() {
    const subset = this._cellSubset;
    if (subset === null) return null;
    const { rows: _rows, fileRows: _fileRows, ...plain } = subset;
    return plain;
  }

  /**
   * The store's root, checked from what opening loaded: an AnnData root
   * (its encoding) holding obs and var. Checked before anything else is
   * (the embedding, the cells), so a store that is no AnnData store is
   * refused as that. @private
   */
  _requireAnnDataRoot() {
    const root = this._root;
    const format = this._format;
    const fileLabel = `${format.file} root`;
    requireExactStringAttribute(root, 'encoding-type', 'anndata', fileLabel);
    requireExactStringAttribute(root, 'encoding-version', '0.1.0', fileLabel);
    if (!root.has('obs')) throw new AnnDataFormatError(`${format.file} obs is required and must be a current AnnData dataframe`);
    if (!root.has('var')) throw new AnnDataFormatError(`${format.file} var is required and must be a current AnnData dataframe`);
  }

  /**
   * The store's structure, checked (its root by `_requireAnnDataRoot`,
   * before). The var index is checked (its length and
   * kind) but its names are not read: no view waits for the gene names, and
   * they are read when first asked for (`readVarNames`). `carry`: the reader
   * of an earlier opening of the same store, whose title is this one's.
   * @private
   */
  async _readStructure(readOptions = {}, carry = null) {
    const root = this._root;
    const format = this._format;
    const obs = root.get('obs');
    const var_ = root.get('var');
    // Each frame's index and nested column names (`loadFrameStructure`), the
    // other var frames' too (`raw.var`, each modality's), all at once.
    const otherVarFrames = this._otherVarFrames(root);
    await Promise.all([obs, var_, ...otherVarFrames.map(([frame]) => frame)]
      .map(frame => loadFrameStructure(frame, readOptions)));
    const obsSchema = validateDataFrame(obs, format, `${format.file} obs`);
    const varSchema = validateDataFrame(var_, format, `${format.file} var`);

    const hasX = root.has('X');
    let nObs = 0;
    let nVars = 0;
    if (hasX) {
      const X = root.get('X');
      if (isGroup(X)) {
        // A subsample's CSR X is checked as stored: its kept rows' arrays
        // are made when it is first read (`_readyRows`), and only its shape
        // is the view's.
        const stored = this._fullRoot !== null && this._fullRoot !== root && X.rowPointersPending?.() === true
          ? this._fullRoot.get('X')
          : X;
        const sparse = sparseContract(stored, format, 'Sparse X');
        [nObs, nVars] = stored === X ? sparse.shape : shapeFromAttribute(attributeValue(X, 'shape'), 'Sparse X');
        const element = X.path.replace(/^\/+/, '');
        if (sparse.format === 'csc' && !this._pointerReads.has(element)) {
          // A gene of a CSC matrix reads its range of the pointers first:
          // read them now, beside the indexes, and the first gene is one
          // round trip. A failure reaches the first gene read, not opening.
          // (An earlier opening of the store read them already: `carry`.)
          const pointers = readIntegers(sparse.indptrArray, 0, nVars + 1, 'Sparse X indptr', readOptions);
          pointers.catch(() => {});
          this._pointerReads.set(element, pointers);
        }
      } else {
        validateArrayEncoding(X, format, 'Dense X', 'array');
        [nObs, nVars] = shapeOf(X, 'Dense X', 2);
        if (!isAnnDataMatrixDataKind(valueKind(X))) throw new AnnDataFormatError('Dense X must use a numeric or boolean dtype');
      }
    }
    // The title (one small read) is read beside the indexes: dataset
    // metadata then never waits a round trip for it.
    this._title = carry?._title ?? readUnsTitle(root, readOptions);
    this._title.catch(() => {});
    // What the file says about itself for Cellucid is part of opening it: a
    // malformed entry refuses the file, so it is read with the indexes. (Of
    // the open cells: a subsample's view gathers its per-cell entries.)
    const unsCellucid = child(child(root, 'uns'), 'cellucid');
    const [obsIndex, varIndex, cellucid] = await Promise.all([
      readDataFrameIndex(obs.get(obsSchema.indexKey), format, 'Observation index', hasX ? nObs : null, false, readOptions),
      readDataFrameIndex(var_.get(varSchema.indexKey), format, 'Variable index', hasX ? nVars : null, false, readOptions),
      unsCellucid === null ? null : readUnsCellucid(unsCellucid, readOptions),
    ]);
    this._cellucid = cellucid;
    if (!hasX) {
      nObs = obsIndex.length;
      nVars = varIndex.length;
    }
    // Each column is checked on its own (no value is read): one this reader
    // does not understand is left out with the reason (`notes`), never the
    // dataset refused for it. The index, the shape and X are what the file
    // needs.
    const notes = [];
    const readable = (frame, columnOrder, frameLabel, length) => columnOrder.filter(key => {
      const defect = columnDefect(frame, key, format, frameLabel, length);
      if (defect !== null) notes.push(defect);
      return defect === null;
    });
    const obsColumns = readable(obs, obsSchema.columnOrder, 'obs', nObs);
    readable(var_, varSchema.columnOrder, 'var', nVars);
    if (root.has('obsm')) requireMapping(root.get('obsm'), format, `${format.file} obsm mapping`);
    if (nObs === 0) console.warn('[AnnDataReader] AnnData has 0 cells');
    if (!hasX) console.warn('[AnnDataReader] No X matrix: gene expression is not available');
    this._nObs = nObs;
    this._nVars = nVars;
    if (Array.isArray(root.modalities) && root.modalities.length > 0) {
      this._modalities = new Map(root.modalities.map(modality => [
        modality.name,
        { modality, cells: cellMapOf(modality, nObs) },
      ]));
      this._defaultModality = root.defaultModality;
      for (const { modality } of this._modalities.values()) {
        if (!isGroup(child(child(root, 'mod'), modality.name))) {
          throw new AnnDataFormatError(`${format.file} modality '${modality.name}' has no mod group`);
        }
      }
    }
    // A priority-ordered file's original positions are how its cells are
    // named (`priority-layout.js`, the cell identity), not a field: listed,
    // they would be offered for coloring and filtering and written into
    // exports, where a subset's positions no longer name its rows.
    // So are each modality's own (a MuData in priority order: its rows
    // follow their cells, `<modality>:cellucid_original_position`).
    // Only a verified record (`priority-layout.js`): one that does not
    // describe the cells leaves the column an ordinary one.
    const priorityOrdered = this._cellSubset?.prioritySeed != null;
    const positions = new Set([PRIORITY_ORIGINAL_COLUMN, ...[...(this._modalities?.keys() ?? [])].map(name => `${name}:${PRIORITY_ORIGINAL_COLUMN}`)]);
    this._obsKeys = obsColumns.filter(key => !(priorityOrdered && positions.has(key)));
    for (const [frame, frameLabel, length] of otherVarFrames) {
      readable(frame, validateDataFrame(frame, format, frameLabel).columnOrder, frameLabel, length);
    }
    this._notes = Object.freeze(notes);
    if (notes.length > 0) console.warn(`[AnnDataReader] ${this._name}: ${notes.join(' ')}`);
  }

  /**
   * The var frames besides the root's whose columns the data-mapping
   * catalog lists (`probeColumns`): `raw.var` and each modality's `var`,
   * each with its length when the matrix beside it states one. The
   * modalities are the store's (`root.modalities`): the frames are asked
   * for before `_modalities` is made from them. @private
   */
  _otherVarFrames(root) {
    const frames = [];
    const add = (group, frameLabel) => {
      const frame = child(group, 'var');
      if (!isGroup(frame)) return;
      const matrix = child(group, 'X');
      const shape = matrix === null ? null : (isGroup(matrix) ? attributeValue(matrix, 'shape') : matrix.shape);
      frames.push([frame, frameLabel, Array.isArray(shape) && shape.length === 2 ? Number(shape[1]) : null]);
    };
    add(child(root, 'raw'), 'raw.var');
    for (const { name } of Array.isArray(root.modalities) ? root.modalities : []) add(child(child(root, 'mod'), name), `${name} var`);
    return frames;
  }

  /**
   * The store as stored, for a copy of the whole dataset (`write/copy.js`):
   * every cell, whichever are open. Refused while the store does not hold
   * every row of its matrix yet (a matrix read after its map, `held`).
   *
   * @returns {Object}
   */
  storedRoot() {
    const root = this._fullRoot ?? this._root;
    if (root === null) throw new Error('No dataset is open to copy.');
    if (this._held != null && this._held.rows < (frameRows(root.get('obs')) ?? 0)) {
      throw new Error('The expression matrix of this dataset is still being read: a copy can be saved once every cell\'s values are in.');
    }
    return root;
  }

  /**
   * What opening left out of the dataset, and why: the columns of `obs`,
   * `var`, `raw.var` and each modality's `var` this reader cannot read
   * (`columnDefect`), one sentence each.
   *
   * @returns {readonly string[]}
   */
  get notes() { return this._notes; }

  get nObs() { return this._nObs; }

  get nVars() { return this._nVars; }

  get obsKeys() { return [...this._obsKeys]; }

  /** Whether the dataset has an expression matrix (`X` may be absent). */
  get hasExpressionMatrix() { return this._root?.has('X') === true; }

  get isOpen() { return this._root !== null; }

  /**
   * The modality one element or var axis names (`mod/<name>/…`), and the
   * rest of it; `{modality: null, rest}` for the root's.
   */
  _splitModality(path) {
    if (typeof path !== 'string' || !path.startsWith('mod/')) return { modality: null, rest: path };
    const end = path.indexOf('/', 'mod/'.length);
    const name = end < 0 ? path.slice('mod/'.length) : path.slice('mod/'.length, end);
    const entry = this._modalities?.get(name);
    if (entry === undefined) throw new Error(`This file has no modality '${name}'`);
    return { modality: entry, rest: end < 0 ? '' : path.slice(end + 1) };
  }

  /**
   * Entries a long read keeps requested at once: two slabs read ahead, as
   * every streamed read does; over a slower link, at least what fills every
   * request the link runs at once. A scheduling choice, not a limit.
   */
  _inFlightEntries() {
    const slabs = 2 * SLAB_BYTES;
    const link = this._readsAhead() ? null : this._link.snapshot();
    const bytes = link === null ? slabs : Math.max(slabs, link.maxRequestBytes * link.concurrency);
    return Math.floor(bytes / 8);
  }

  /** Whether the store's link delivers bytes as fast as a disk (see `open`). */
  _readsAhead() {
    return this._link === null || this._link.readsAhead;
  }

  /**
   * Rows `[start, end)` of the open cells as `{start, end}`, checked; null for
   * every row (`rows` null, or exactly `[0, nObs)`).
   */
  _rowRange(rows, label) {
    if (rows === null || rows === undefined) return null;
    const [start, end] = Array.isArray(rows) && rows.length === 2 ? rows : [NaN, NaN];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > this._nObs) {
      throw new RangeError(`Rows of ${label} are [start, end) within the ${formatCountOf(this._nObs, 'open cell')}; got ${JSON.stringify(rows)}`);
    }
    return start === 0 && end === this._nObs ? null : { start, end };
  }

  /**
   * Whether reading every row of a cell-major matrix (a CSR group, or a
   * dense array in row chunks) from the first of `rows` to the last reads
   * no more stored bytes than reading `rows` alone (ascending, of its
   * `nRows`): they lie in every chunk of that span, so the whole reads
   * nothing more, in fewer requests. Priced as the first gene prices a
   * matrix's rows (`firstGeneReadCost`: the stored chunks of its pointers,
   * indices and values -- the values only unless `valuesOnDemand` -- the
   * rows lie in, with the gaps the link joins reads across), unless every
   * gap between two rows is shorter than a chunk of each array (rows taken
   * to hold the mean entries): then the rows lie in every chunk, without
   * pricing each row, which at millions of cells is itself time spent
   * (measured: 24_decisions_graph_edges_at_scale.md). What a graph's induced
   * subgraph streams by (`_graphReadPlan`) and a share's genes are indexed
   * by (`_restrictsWhole`).
   */
  async _readsNoMoreThanRows({ node, rows, nRows, valuesOnDemand }) {
    if (rows.length === 0) return false;
    let widest = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i] - rows[i - 1] > widest) widest = rows[i] - rows[i - 1];
    const chunkOf = array => (Array.isArray(array?.chunks) && array.chunks.length > 0 && array.partialChunks !== true ? Number(array.chunks[0]) : null);
    if (isGroup(node)) {
      const [pointerChunk, indexChunk, valueChunk] = ['indptr', 'indices', 'data'].map(name => chunkOf(node.get(name)));
      const perRow = node.get('indices').shape[0] / nRows;
      if (pointerChunk !== null && indexChunk !== null && valueChunk !== null &&
        widest <= pointerChunk && widest * perRow <= Math.min(indexChunk, valuesOnDemand ? indexChunk : valueChunk)) return true;
    } else {
      const rowChunk = chunkOf(node);
      if (rowChunk !== null && widest <= rowChunk) return true;
    }
    // The matrix's price, made once per merge gap (it moves with the link).
    const link = pricingLink(this._link?.snapshot?.() ?? null, this._hostLink ?? null);
    const mergeGapBytes = link?.mergeGapBytes ?? this._mergeGapBytes();
    let priced = this._rowsCosts.get(node);
    if (priced === undefined || priced.mergeGapBytes !== mergeGapBytes || priced.valuesOnDemand !== valuesOnDemand) {
      priced = {
        mergeGapBytes,
        valuesOnDemand,
        cost: await firstGeneReadCost(null, nRows, {
          expression: node,
          valuesOnDemand,
          decodedChunkBytes: this._decodedChunkBytes,
          mergeGapBytes,
        }),
      };
      this._rowsCosts.set(node, priced);
    }
    if (priced.cost === null) return false;
    const own = priced.cost(rows);
    const whole = priced.cost({ count: 1, starts: [rows[0]], ends: [rows[rows.length - 1] + 1] });
    // Else the whole would read chunks no row lies in, past the gaps the
    // link joins reads across (`mergeGapBytes`, already in the rows' price).
    return whole.decodedBytes <= own.decodedBytes && whole.bytes <= own.bytes;
  }

  /** Refuse a request while no dataset is open. */
  _ensureOpen() {
    if (this._closed || !this._root) throw new Error('No AnnData file is open. Call open() first.');
  }

  /**
   * Refuse the result of a request begun at `generation` once the dataset,
   * or its caches, changed under it (`_superseded`).
   */
  _assertGeneration(generation, operation = 'loading AnnData data') {
    if (this._closed || generation !== this._generation) throw this._superseded(operation);
  }

  /**
   * Why a request of this reader's dataset stopped (`_assertGeneration`),
   * and why its store was closed under the reads still under way
   * (`_releaseCurrentState`): never a failure -- the file was closed, or the
   * dataset or its caches were replaced under the request (released: asked
   * again, it works). @private
   */
  _superseded(operation) {
    return cancelled(
      this._closed ? 'closed' : 'released',
      `${this._format?.file ?? 'AnnData'} dataset changed, cache was cleared, or file was closed while ${operation}; the request was superseded`
    );
  }

  /** Drop every cached field, name list, matrix index and row pointers. */
  clearCache() {
    this._cellSubsetGenes = null;
    this._cellSubsetRowsCost = null;
    this._cellSubsetChecked = null;
    this._generation++;
    this._cache.clear();
    this._decodedChunks?.clear();
    this._indptrs.clear();
    this._indptrPrefixes.clear();
    this._knownRowPointers.clear();
    // Row access is released even when releasing a matrix fails.
    try {
      this._releaseMatrices();
    } finally {
      this._releaseRows();
    }
  }

  /** The bytes of the row pointers kept (`_indptrs`, `_indptrPrefixes`, `_knownRowPointers`, the open view's own). */
  _rowPointerBytes() {
    // Each buffer once: the open subset's view holds pointers of its own
    // (the kept rows' read, what its CSR matrices made of them), some the
    // same arrays as these maps.
    const buffers = new Set(this._root?.heldBuffers?.() ?? []);
    const add = pointers => {
      if (ArrayBuffer.isView(pointers)) buffers.add(pointers.buffer);
      else if (pointers !== null && typeof pointers === 'object') {
        for (const array of Object.values(pointers)) if (ArrayBuffer.isView(array)) buffers.add(array.buffer);
      }
    };
    for (const pointers of this._indptrs.values()) add(pointers);
    for (const pointers of this._indptrPrefixes.values()) add(pointers);
    for (const pointers of this._knownRowPointers.values()) add(pointers);
    let bytes = 0;
    for (const buffer of buffers) bytes += buffer.byteLength;
    return bytes;
  }

  /**
   * What the gene-column indexes and the row pointers they are built from
   * hold in memory (the `columnIndex` share, `memory-budget.js`).
   *
   * @returns {number}
   */
  residentBytes() {
    let bytes = this._rowPointerBytes() + this._cellSubsetBytes();
    for (const state of this._matrices.values()) bytes += state.columns?.residentBytes?.() ?? 0;
    return bytes;
  }

  /**
   * Hold no more than `budget` bytes of gene-column indexes and row
   * pointers: the row pointers go first (one array read to get again), then
   * the indexes, least recently read first (a pass over the matrix to build
   * again). The index of the matrix read last stays unless `budget` is 0
   * (as `_settleMatrices` keeps it). An index being built stops; the genes
   * waiting on it are still answered.
   *
   * @param {number} budget
   * @returns {string[]} What was let go, in words
   */
  trimResident(budget) {
    const released = [];
    // The cells' genes a run keeps go first: the next batch reads their rows again.
    if (this.residentBytes() > budget && this._cellSubsetBytes() > 0) {
      this._cellSubsetGenes = null;
      this._cellSubsetChecked = null;
      released.push('the genes of an analysis\'s cells');
    }
    if (this.residentBytes() > budget && (this._indptrs.size > 0 || this._indptrPrefixes.size > 0 || this._knownRowPointers.size > 0)) {
      this._indptrs.clear();
      this._indptrPrefixes.clear();
      this._knownRowPointers.clear();
      released.push('row pointers');
    }
    let indexes = 0;
    const states = [...this._matrices.values()];
    if (budget > 0) states.pop();
    for (const state of states) {
      if (this.residentBytes() <= budget) break;
      if (state.columns === null) continue;
      this._releaseMatrixState(state);
      indexes++;
    }
    if (indexes > 0) released.push(indexes === 1 ? 'a gene index' : `${indexes} gene indexes`);
    return released;
  }

  /**
   * Let go of the store without closing it: a reader of another cell subset
   * of the same bytes reads through it from now on (the reader worker's
   * `open`), with its structure, chunk indexes and caches. Closing this
   * reader afterwards releases its own state only.
   */
  releaseStore() {
    this._store = null;
  }

  /**
   * Close the store and let go of the current opening's state (its cells,
   * caches, indexes and counts), each release tried whatever the others do;
   * a failure is thrown once all were tried. @private
   */
  _releaseCurrentState() {
    let failure = null;
    const record = error => {
      const exact = error instanceof Error ? error : new TypeError('AnnData resource release must reject with an Error.', { cause: error });
      failure = failure === null ? exact : combineDatasetLifecycleFailures(failure, exact, 'Multiple AnnData resources failed to release.');
    };
    if (this._store) {
      // A store whose close failed stays owned, so a later close retries it.
      // Its reads still under way stop, each rejecting as this reader's
      // requests do once it moved on (`_superseded`).
      try {
        this._store.close?.(this._superseded('reading it'));
        this._store = null;
      } catch (error) {
        record(error);
      }
    }
    this._root = null;
    this._fullRoot = null;
    this._cellSubset = null;
    this._identifierColumns.clear();
    setWorkingSet(this._cellRowsPart, 0);
    this._expression = null;
    this._prefixReads = new Map();
    this._levelCounts = new Map();
    this._keptRunDirectories = new Map();
    this._rowsCosts = new WeakMap();
    try {
      this.clearCache();
    } catch (error) {
      record(error);
    }
    this._nObs = 0;
    this._nVars = 0;
    this._obsKeys = [];
    this._notes = Object.freeze([]);
    if (failure !== null) throw failure;
  }

  /** Close the store and release everything held. */
  close() {
    if (this._closed && !this._root && !this._store) return;
    this._openRequestId++;
    this._closed = true;
    // Its hold on the store's decoded chunks goes: they go once no opening
    // holds them (one that carried this one holds them still: `open`, `carry`).
    this._decodedChunks?.release();
    this._decodedChunks = null;
    this._subsampleCache = null;
    this._categoryCodings = new Map();
    this._releaseCurrentState();
  }
}

applyMixin(AnnDataReader.prototype, AnnDataReaderStoredOutlierMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderNameMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderObsmMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderFieldMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderGraphMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderMappingProbeMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderMatrixRowMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderGeneColumnMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderCellSubsetMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderGeneSampleMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderKeptIndexMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderRowPointerMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderMatrixMethods.prototype);
applyMixin(AnnDataReader.prototype, AnnDataReaderGeneSegmentMethods.prototype);
