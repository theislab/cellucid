/**
 * @fileoverview DataState coordinator.
 *
 * Owns core typed arrays and dataset metadata, and exposes the state API by
 * mixing in method surfaces from `state/managers/*`.
 *
 * @module state/core/data-state
 */
import { LRUCache } from '../../../data/sparse-utils.js';
import { EventEmitter } from '../../utils/event-emitter.js';
import { RenameRegistry } from '../../registries/rename-registry.js';
import { DeleteRegistry } from '../../registries/delete-registry.js';
import { UserDefinedFieldsRegistry } from '../../registries/user-defined-fields.js';
import { getFieldRegistry } from '../../utils/field-registry.js';
import { HighlightManager, highlightStateMethods } from '../managers/highlight-manager.js';
import { FieldManager, DataStateFieldMethods } from '../managers/field-manager.js';
import { FilterManager, DataStateFilterMethods } from '../managers/filter-manager.js';
import { ColorManager, DataStateColorMethods } from '../managers/color-manager.js';
import { ViewManager, DataStateViewMethods } from '../managers/view-manager.js';

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
    this.positionsArray = null;       // normalized positions used for smoke density
    this.colorsArray = null;
    this.outlierQuantilesArray = null;
    this.categoryTransparency = null;
    this.obsData = null;
    this.varData = null;
    this.activeFieldIndex = -1;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = null; // 'obs', 'var', or null
    this.filteredCount = { shown: 0, total: 0 };

    this.centroidCount = 0;
    this.centroidPositions = null;
    this.centroidColors = null; // RGBA uint8 (alpha packed in)
    this.centroidLabels = [];
    this.centroidOutliers = null;

    this._visibilityScratch = null; // reusable mask for connectivity visibility
    this._activeCategoryCounts = null;
    this.activeViewId = 'live';
    this.viewContexts = new Map(); // viewId -> per-view context (arrays + field state)
    // LRU caches for field data to prevent unbounded memory growth
    // Obs fields: max 50 (each ~10 bytes × pointCount)
    // Var fields: max 20 (gene expressions, each ~4 bytes × pointCount, typically larger access pattern)
    this._fieldDataCache = new LRUCache(50); // field.key -> loaded arrays (shared across views)
    this._varFieldDataCache = new LRUCache(20); // var.field.key -> loaded arrays

    // Multi-dimensional embedding support
    this.dimensionManager = null; // Set via setDimensionManager()
    this.activeDimensionLevel = 3; // Current dimension level for live view (1, 2, 3, or 4)

    // Cell highlighting/selection state - multi-page system
    // Each page contains its own independent set of highlight groups
    this.highlightPages = []; // Array of { id, name, highlightedGroups: [] }
    this.activePageId = null; // Currently active page ID
    this._highlightPageIdCounter = 0;
    this.highlightArray = new Uint8Array(0); // Uint8Array per-point highlight intensity (0-255)
    this._highlightIdCounter = 0;
    this._cachedHighlightCount = null; // Cached visible highlight count
    this._cachedTotalHighlightCount = null; // Cached total highlight count
    this._cachedHighlightLodLevel = null; // LOD level used for cached visible highlight count

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

    // Bind singleton registry for fast lookups.
    getFieldRegistry().bind(this);
  }
}

function applyMixin(targetProto, mixinProto) {
  const descriptors = Object.getOwnPropertyDescriptors(mixinProto);
  delete descriptors.constructor;
  Object.defineProperties(targetProto, descriptors);
}

applyMixin(DataState.prototype, DataStateViewMethods.prototype);
applyMixin(DataState.prototype, DataStateFieldMethods.prototype);
applyMixin(DataState.prototype, DataStateColorMethods.prototype);
applyMixin(DataState.prototype, DataStateFilterMethods.prototype);
Object.defineProperties(DataState.prototype, Object.getOwnPropertyDescriptors(highlightStateMethods));

Object.defineProperties(DataState.prototype, {
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
