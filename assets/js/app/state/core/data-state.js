/**
 * @fileoverview DataState coordinator.
 *
 * Owns core typed arrays and dataset metadata, and exposes the state API by
 * mixing in method surfaces from `state/managers/*`.
 *
 * @module state/core/data-state
 */
import { EventEmitter } from '../../utils/event-emitter.js';
import { RenameRegistry } from '../../registries/rename-registry.js';
import { DeleteRegistry } from '../../registries/delete-registry.js';
import { UserDefinedFieldsRegistry } from '../../registries/user-defined-fields.js';
import { DerivedResultsRegistry } from '../../registries/derived-results.js';
import { createCellIdentity } from '../../../data/cell-identity.js';
import { DEFAULT_CELL_PRIORITY } from '../../../data/cell-priority.js';
import { getFieldRegistry } from '../../utils/field-registry.js';
import { HighlightManager, highlightStateMethods } from '../managers/highlight-manager.js';
import { FieldManager, DataStateFieldMethods } from '../managers/field-manager.js';
import { FilterManager, DataStateFilterMethods } from '../managers/filter-manager.js';
import { ColorManager, DataStateColorMethods } from '../managers/color-manager.js';
import { ViewManager, DataStateViewMethods } from '../managers/view-manager.js';
import { DataStateMappingMethods } from '../managers/mapping-manager.js';
import { DataStateMappingGroupMethods } from '../managers/mapping-groups.js';
import { DataStateVarAxisMethods } from '../managers/var-axis.js';
import { DataStateLatentSpaceMethods } from '../managers/latent-space.js';
import { DataStateOutlierQuantileMethods } from '../managers/outlier-quantiles.js';
import { DataStateOpenCellsMethods } from '../managers/open-cells.js';

export function createDataState({ viewer, labelLayer }) {
  return new DataState(viewer, labelLayer);
}

export class DataState extends EventEmitter {
  constructor(viewer, labelLayer) {
    super();
    this.viewer = viewer;
    this.labelLayer = labelLayer;
    this.fieldLoader = null;
    this.varFieldLoader = null;

    this.pointCount = 0;
    // Which of the dataset's cells are open, and their original positions
    // (data/cell-identity.js): every cell named outside the app is named by
    // it. Published with each scene (`initScene`, `setCellIdentity`).
    this.cellIdentity = createCellIdentity({ nObs: 0 });
    // The order every "first cells" sample is taken in (data/cell-priority.js):
    // levels of detail and progressive analyses. Published with each scene
    // (`initScene`, `setCellPriority`).
    this.cellPriority = DEFAULT_CELL_PRIORITY;
    // Live view's normalized positions, `positionsDimension` components per
    // cell (see rendering/position-layout.js). The two are assigned together.
    this.positionsArray = new Float32Array(0);
    this.positionsDimension = 3;
    this.colorsArray = new Uint8Array(0);
    // Per-cell visibility of the active view: exactly 0 (hidden) or 1
    // (shown). Every filter is a binary predicate, so one byte a cell holds
    // every value this array can take; see rendering/alpha-visibility.js.
    this.categoryTransparency = new Uint8Array(0);
    // Per-cell user mask (setCellVisibility), exactly 0 or 1, ANDed into
    // `categoryTransparency` by computeGlobalVisibility().
    this.cellVisibilityMask = new Uint8Array(0);
    // The transparency array whose bytes the live viewer holds, with its write
    // count then (`_pushTransparencyToViewer`); null when not known.
    this._liveViewerTransparency = null;
    this.obsData = null;
    this.varData = null;
    this._obsFieldDescriptors = Object.freeze([]);
    this._varFieldDescriptors = Object.freeze([]);
    // Monotonic scientific dataset owner. Async field loads capture this value
    // and may publish only while the exact generation remains current.
    this._datasetGeneration = 0;
    this.activeFieldIndex = -1;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = null; // 'obs', 'var', or null
    this.filteredCount = { shown: 0, total: 0 };

    this.centroidCount = 0;
    this.centroidPositions = new Float32Array(0);
    this.centroidColors = new Uint8Array(0); // RGBA uint8 (alpha packed in)
    this.centroidLabels = [];

    this._activeCategoryCounts = null;
    this.activeViewId = 'live';
    this.viewContexts = new Map(); // viewId -> per-view context (arrays + field state)
    // Loaded field arrays by cache key (shared across views). Their bound is
    // in bytes, not entries: see state/managers/field/residency.js, which
    // releases inactive fields from these maps and from every field object.
    this._fieldDataCache = new Map(); // obs field key -> loaded arrays
    this._varFieldDataCache = new Map(); // gene key -> loaded arrays

    // Multi-dimensional embedding support
    // The layout registry, and the one owner of the representation each view
    // shows (see getViewLayoutKey / getViewDimensionLevel). Set via
    // setDimensionManager().
    this.dimensionManager = null;
    this._dimensionChangeLock = null; // Serializes representation changes to prevent cross-await state corruption

    // The data mapping the loaded dataset is shown with (see
    // data/dataset-mapping.js), recorded in every session fingerprint. Null
    // when no dataset is loaded. Owned by state/managers/mapping-manager.js:
    // published with publishDatasetMapping(), changed with applyDataMapping().
    this.dataMapping = null;
    this._mappingCandidates = null;
    this._mappingOrigin = null;
    this._mappingPublicationOrigin = null;
    // Embeddings that failed their load-time check: obsm key -> reason.
    // They stay unusable for the rest of the dataset's session.
    this._unusableEmbeddings = new Map();
    this._mappingChangeLock = null;
    // The other mapping groups (state/managers/mapping-groups.js): choices
    // refused at load time this session (group -> key -> reason), and the
    // owners outside DataState a mapping transaction publishes through.
    this._unusableMappingChoices = new Map();
    this._mappingRuntime = null;
    // Replacements of the var axis since the dataset was published
    // (state/managers/var-axis.js).
    this._varAxisGeneration = 0;

    // Optional per-cell vector fields (e.g., velocity, CellRank drift) tied to embedding dimensions.
    // Set via views.setVectorFieldManager() from the app bootstrap when available.
    this.vectorFieldManager = null;

    // Cell highlighting/selection state - multi-page system
    // Each page contains its own independent set of highlight groups
    this.highlightPages = []; // Array of { id, name, highlightedGroups: [] }
    this.activePageId = null; // Currently active page ID
    this._highlightPageIdCounter = 0;
    this.highlightArray = new Uint8Array(0); // Uint8Array per-point highlight intensity (0-255)
    this._highlightedCellIndices = new Uint32Array(0);
    this._highlightIdCounter = 0;
    this._cachedHighlightCount = null; // Cached visible highlight count
    this._cachedTotalHighlightCount = null; // Cached total highlight count
    this._cachedHighlightLodMembership = null; // Exact shared LOD owner used by the cached visible count

    // Batch mode: suppresses expensive recomputations during bulk filter restoration
    this._batchMode = false;
    this._batchDepth = 0; // Track nested batch calls
    this._batchDirty = { visibility: false, colors: false, affectedFields: new Set() };

    // -----------------------------------------------------------------------
    // Field operations (rename / delete / user-defined categoricals)
    // -----------------------------------------------------------------------

    this._renameRegistry = new RenameRegistry();
    this._deleteRegistry = new DeleteRegistry();
    this._userDefinedFields = new UserDefinedFieldsRegistry();
    // Gene sets and scores besides the fields: a notebook's pushed sets, the
    // shown marker and gene signature results (registries/derived-results.js).
    this._derivedResults = new DerivedResultsRegistry();

    // Bind singleton registry for fast lookups.
    getFieldRegistry().bind(this);

    // UI controls are initialized even when no dataset is selected. Publish
    // that zero-cell runtime as the same exact live-view contract used after
    // dataset adoption, so startup never needs a fabricated view identity.
    this._resetViewContexts();
  }
}

function applyMixin(targetProto, mixinProto) {
  const descriptors = Object.getOwnPropertyDescriptors(mixinProto);
  delete descriptors.constructor;
  Object.defineProperties(targetProto, descriptors);
}

applyMixin(DataState.prototype, DataStateViewMethods.prototype);
applyMixin(DataState.prototype, DataStateMappingMethods.prototype);
applyMixin(DataState.prototype, DataStateMappingGroupMethods.prototype);
applyMixin(DataState.prototype, DataStateVarAxisMethods.prototype);
applyMixin(DataState.prototype, DataStateLatentSpaceMethods.prototype);
applyMixin(DataState.prototype, DataStateOutlierQuantileMethods.prototype);
applyMixin(DataState.prototype, DataStateOpenCellsMethods.prototype);
applyMixin(DataState.prototype, DataStateFieldMethods.prototype);
applyMixin(DataState.prototype, DataStateColorMethods.prototype);
applyMixin(DataState.prototype, DataStateFilterMethods.prototype);
Object.defineProperties(DataState.prototype, Object.getOwnPropertyDescriptors(highlightStateMethods));

Object.defineProperties(DataState.prototype, {
  getDerivedResults: {
    value() { return this._derivedResults; }
  },
  fields: {
    get() { return this._fieldsManager || (this._fieldsManager = new FieldManager(this)); }
  },
  filters: {
    get() { return this._filtersManager || (this._filtersManager = new FilterManager(this)); }
  },
  colors: {
    get() { return this._colorsManager || (this._colorsManager = new ColorManager(this)); }
  },
  highlights: {
    get() { return this._highlightsManager || (this._highlightsManager = new HighlightManager(this)); }
  },
  views: {
    get() { return this._viewsManager || (this._viewsManager = new ViewManager(this)); }
  }
});
