/**
 * @fileoverview Every method of the state (`DataState`) and of the viewer's
 * public API, classified by what it does to the state a person's step holds:
 *
 * - `reads()`: changes nothing.
 * - `internal(reason)`: changes no state domain's value a step covers (its
 *   reason, from `INTERNAL_REASONS`, says why: the state's own
 *   synchronization, a restore, a dataset's publication, a selection in
 *   progress, …).
 * - `mutates(domains, actions)`: changes the value of `domains`
 *   (`domains.js`); `actions` are the catalog's action types that own the
 *   change. A control never calls it: it dispatches one of those actions
 *   (`control-dispatch.js`), or, for a setting or a camera gesture, the
 *   owner applies the change and it is recorded by observation
 *   (`recordObserved`).
 *
 * `MUTATION_OWNERS` lists the modules that may call `mutates` methods (the
 * actions' implementations, the domain owners, the observation recorders,
 * a dataset's publication), each with the methods it may call and why;
 * `NAME_COLLISIONS` the calls of another object's method of the same name.
 *
 * The drift guards: `tests/action-method-classification-contract.test.mjs`
 * fails on a method that is not classified here (a new `DataState` mixin
 * method, a new viewer API method), on a classification of a method that is
 * gone, and on an action type the catalog lacks;
 * `tests/action-mutation-owners-contract.test.mjs` fails on a call of a
 * `mutates` method outside its owners, and on an owner entry that no longer
 * holds. Underscore members of `DataState` are internal by construction:
 * the second test fails on a call of one outside `app/state/`.
 *
 * Pure: importable in Node, no app state.
 *
 * @module app/actions/classification
 */

export const METHOD_KINDS = Object.freeze(['reads', 'internal', 'mutates']);

/** Why an `internal` method changes no state a step covers. */
export const INTERNAL_REASONS = Object.freeze({
  'state-layer': 'the state\'s own synchronization: arrays pushed to the viewer, summaries and colors recomputed from the domains\' values',
  restore: 'how a domain owner or a restore path puts a value back',
  dataset: 'a dataset\'s publication or its cells read again: the state every history of it starts from',
  wiring: 'a callback or handler installed once when a module starts',
  lifecycle: 'starting, pausing or disposing the viewer',
  diagnostics: 'tests, benchmarks and renderer statistics',
  transient: 'UI-local state in no domain: a selection in progress, a tool mode, a preview, a pointer capture',
  derived: 'data loaded, cached or computed from the domains\' values (metadata, gene reads, edges, smoke), never a value of its own',
});

/** @returns {{kind: 'reads'}} */
export function reads() {
  return Object.freeze({ kind: 'reads' });
}

/**
 * @param {keyof typeof INTERNAL_REASONS} reason
 * @returns {{kind: 'internal', reason: string}}
 */
export function internal(reason) {
  return Object.freeze({ kind: 'internal', reason });
}

/**
 * @param {string|string[]} domains - the state domains whose value it changes
 * @param {string[]} actions - the action types that own the change
 * @returns {{kind: 'mutates', domains: string[], actions: string[]}}
 */
export function mutates(domains, actions) {
  return Object.freeze({
    kind: 'mutates',
    domains: Object.freeze([domains].flat()),
    actions: Object.freeze([...actions]),
  });
}

const SETTING = Object.freeze(['setting.set']);
const SETTING_OR_RESET = Object.freeze(['setting.set', 'display.reset']);

/**
 * Every public member of `DataState.prototype` (`app/state/core/data-state.js`
 * and its mixins in `app/state/managers/`), accessors included.
 */
export const DATA_STATE_METHODS = Object.freeze({
  // data-state.js
  pointCount: internal('dataset'),
  cellIdentity: internal('dataset'),
  // The registry's notebook gene sets change through `gene-set.save`; the
  // analyses' own sets are their results (`analysis` domain).
  getDerivedResults: reads(),
  fields: reads(),
  filters: reads(),
  colors: reads(),
  highlights: reads(),
  views: reads(),

  // view-manager.js
  beginBatch: internal('state-layer'),
  endBatch: internal('state-layer'),
  setDimensionManager: internal('dataset'),
  setVectorFieldManager: internal('dataset'),
  getVectorFieldManager: reads(),
  hasAnyVectorFields: reads(),
  getAvailableVectorFields: reads(),
  getDefaultVectorFieldId: reads(),
  hasVectorField: reads(),
  ensureVectorField: internal('derived'),
  getDimensionManager: reads(),
  getDimensionLevel: reads(),
  getViewDimensionLevel: reads(),
  getViewLayoutKey: reads(),
  viewFollowsDefault: reads(),
  showDefaultRepresentation: mutates('views', ['view.embedding.default']),
  cycleRepresentation: mutates('views', ['view.embedding.cycle']),
  setViewEmbedding: mutates('views', ['view.embedding.set', 'mapping.set']),
  setViewRepresentation: mutates('views', ['view.embedding.set', 'mapping.set']),
  getAvailableDimensions: reads(),
  hasDimension: reads(),

  // view-context-core.js
  setActiveView: mutates('views', ['view.focus', 'view.keep', 'view.remove', 'view.clear']),
  createViewFromSource: mutates('views', ['view.keep']),
  createViewFromActive: mutates('views', ['view.keep']),
  applySnapshotConfigToView: mutates('views', ['view.keep']),
  removeView: mutates('views', ['view.remove', 'view.clear']),
  clearSnapshotViews: mutates('views', ['view.clear']),
  syncSnapshotContexts: internal('state-layer'),
  getActiveViewId: reads(),

  // view-context-viewer-sync.js
  initScene: internal('dataset'),
  initSyntheticScene: internal('dataset'),
  setCellIdentity: internal('dataset'),
  setCellPriority: internal('dataset'),
  getSmokeDensitySource: reads(),

  // mapping-manager.js
  publishDatasetMapping: internal('dataset'),
  adoptMappingCandidates: internal('dataset'),
  getLog1pRefuted: reads(),
  getDataMapping: reads(),
  getDataMappingOrigin: reads(),
  getMappingAnalytics: reads(),
  getMappingCandidates: reads(),
  representationNameOf: reads(),
  getGuessedMappingGroups: reads(),
  getExpressionReason: reads(),
  canMapAnyEmbedding: reads(),
  getEmbeddingUnusableReason: reads(),
  getEnabledRepresentations: reads(),
  getRepresentationChoices: reads(),
  getViewEmbeddingRef: reads(),
  describeViewEmbedding: reads(),
  setViewEmbeddingRef: mutates('views', ['view.embedding.set']),
  describeEmbeddingRefusal: reads(),
  describeDataMappingRefusal: reads(),
  planRepresentationMoves: reads(),
  previewRepresentationMoves: reads(),
  applyDataMapping: mutates('mapping', ['mapping.set']),

  // mapping-groups.js
  setMappingRuntime: internal('wiring'),
  getConnectivityGraphFact: reads(),
  canChangeMappingGroup: reads(),
  getMappingChoiceUnusableReason: reads(),
  getMappingGroupChoices: reads(),
  getGeneNameChoices: reads(),
  getHighlyVariableChoices: reads(),
  getLog1pChoices: reads(),
  getVectorBindingChoices: reads(),
  describeMappingVarCount: reads(),
  describeMappingChoiceRefusal: reads(),
  describeMappingGroupRefusal: reads(),
  openExpressionMatrix: internal('derived'),
  // The gene list and loader a mapping maps, read to install or to price it.
  mappingVarLoaderOf: internal('derived'),
  // Reads under another modality for the length of `read` and puts it back.
  withMappingModality: reads(),
  defaultModalityGroups: reads(),
  // The groups that follow a named modality or matrix (the panel's menus, `mapping.set`).
  followMappingChanges: reads(),
  mappingMatrixHoldsCounts: reads(),

  // expression-values.js
  getExpressionTransform: reads(),
  getShownExpressionTransform: reads(),
  expressionTransformOffer: reads(),
  shownTransformFor: reads(),
  storedCellTotals: reads(),
  cellTotalsPlan: reads(),
  expressionTransformCost: reads(),
  cellTotalsCostOf: reads(),
  mappingTotalsCost: reads(),
  shownCellTotalsCost: reads(),
  shownValuesRecord: reads(),
  mappedLibrarySizes: internal('derived'),
  // The cells' totals a change needs, read (and asked for) before it shows anything.
  cellTotalsForChange: internal('derived'),
  prepareCellTotals: internal('derived'),
  matrixLineage: internal('derived'),
  resetCellTotals: internal('dataset'),
  shownVarLoader: internal('state-layer'),
  renewShownVarLoader: internal('dataset'),
  setExpressionTransform: mutates(['expression', 'filters', 'colors'], ['expression.transform.set', 'cells.open']),

  // var-axis.js, latent-space.js
  beginGeneListing: internal('dataset'),
  areGenesPending: reads(),
  getGeneListFailure: reads(),
  whenGenesListed: reads(),
  listPublishedGenes: internal('dataset'),
  locateVarField: reads(),
  getVarAxisGeneration: reads(),
  getVarAxisGeneCount: reads(),
  stageVarAxisReplacement: internal('state-layer'),
  stageLatentReplacement: internal('state-layer'),

  // outlier-quantiles.js
  getOutlierFilterStatus: reads(),
  ensureOutlierQuantiles: internal('derived'),
  cancelOutlierQuantiles: internal('derived'),
  retireOutlierJobs: internal('dataset'),
  resumeOutlierFilters: internal('derived'),

  // open-cells.js: the cells read again or grown; what a person chose is the
  // `cells` domain's (`cells.open`, `cells.read-genes`).
  resizeOpenCells: internal('dataset'),
  reorderOpenCells: internal('dataset'),
  publishResizedCells: internal('dataset'),
  takeInNewlyOpenCells: internal('dataset'),

  // field/overlay-public.js
  getFields: reads(),
  getVarFields: reads(),
  getActiveField: reads(),
  getRenameRegistry: reads(),
  getDeleteRegistry: reads(),
  getUserDefinedFieldsRegistry: reads(),
  applyFieldOverlays: internal('restore'),
  getVisibleFields: reads(),
  isFieldDeleted: reads(),
  renameField: mutates('field-overlays', ['field.rename']),
  revertFieldRename: mutates('field-overlays', ['field.revert-name']),
  renameCategory: mutates('field-overlays', ['category.rename']),
  deleteField: mutates('field-overlays', ['field.delete']),
  purgeDeletedField: mutates('field-overlays', ['field.purge']),
  restoreField: mutates('field-overlays', ['field.restore']),
  restoreUserDefinedField: mutates('field-overlays', ['field.restore']),
  purgeUserDefinedField: mutates('field-overlays', ['field.purge']),
  duplicateField: mutates('field-overlays', ['field.duplicate']),
  deleteUserDefinedField: mutates('field-overlays', ['field.delete']),
  isUserDefinedField: reads(),
  upsertUserDefinedCategoricalField: mutates('field-overlays', ['field.push', 'field.consensus', 'cells.open']),
  upsertUserDefinedContinuousField: mutates('field-overlays', ['field.push', 'cells.open']),

  // field/category-ops.js
  deleteCategoryToUnassigned: mutates('field-overlays', ['category.delete']),
  mergeCategoriesToNewField: mutates('field-overlays', ['category.merge']),
  groupCategoriesToNewField: mutates('field-overlays', ['field.group']),
  createCategoricalFromPages: mutates('field-overlays', ['field.create-from-pages']),

  // field/loading.js
  setFieldLoader: internal('dataset'),
  setVarFieldLoader: internal('dataset'),
  scheduleLoaderRead: internal('derived'),
  getDatasetGeneration: reads(),
  initVarData: internal('dataset'),
  ensureFieldLoaded: internal('derived'),
  ensureVarFieldLoaded: internal('derived'),
  readVarSparseColumn: reads(),
  readMatrixSparseColumn: reads(),
  readMatrixCellSubset: reads(),
  readVarCellSubset: reads(),
  deliversGenes: reads(),
  isVarFieldDeliverable: reads(),
  openGeneRoute: internal('derived'),
  replaceGeneRoutePort: internal('derived'),
  closeGeneRoute: internal('derived'),
  deliverVarSparseColumns: reads(),
  deliverMatrixSparseColumns: reads(),
  deliverVarCellSubset: reads(),
  deliverMatrixCellSubset: reads(),
  unloadVarField: internal('derived'),
  setActiveField: mutates('active-field', ['color.by', 'cells.open']),
  setActiveVarField: mutates('active-field', ['color.by', 'cells.open']),
  // A gene's colors drawn as its cells are read, and drawn again when its
  // read stopped: the field shown is the same (`color.by` chooses it).
  showPartialVarField: internal('derived'),
  restoreActiveFieldColors: internal('derived'),
  getContinuousFieldRef: reads(),

  // field/summary.js
  getFieldForView: reads(),
  getFilterSummaryForView: reads(),
  updateFilteredCount: internal('state-layer'),
  getFilteredCount: reads(),
  computeCategoryCountsForField: reads(),
  getFilterCellCounts: reads(),

  // field/gene-sample.js: the genes read for more cells; what a person
  // asked for is the `cells` domain's (`cells.read-genes`).
  getGeneSample: reads(),
  refreshGeneSample: internal('derived'),
  noteGeneSample: internal('derived'),
  geneSampleCost: reads(),
  readGenesForMoreCells: internal('derived'),
  topUpGeneSample: internal('derived'),
  holdGeneSample: internal('derived'),
  yieldGeneSampleTopUp: internal('derived'),
  getGeneSampleGrowth: reads(),
  stopReadingGenesForMoreCells: internal('derived'),

  // color-manager.js
  describeContinuousFieldSubject: reads(),
  ensureContinuousMetadata: internal('derived'),
  getContinuousColorDomain: reads(),
  updateColorsContinuous: internal('state-layer'),
  ensureCategoryMetadata: internal('derived'),
  updateColorsCategorical: internal('state-layer'),
  clearCentroids: internal('state-layer'),
  prepareCategoryFieldActivation: internal('derived'),
  buildCentroidsForField: internal('state-layer'),
  updateLegendState: internal('state-layer'),
  applyContinuousFilter: mutates('filters', ['filter.continuous.range']),
  resetContinuousFilter: mutates('filters', ['filter.continuous.reset']),
  setContinuousColorRescale: mutates('colors', ['color.continuous.rescale']),
  setContinuousColorRange: mutates('colors', [
    'color.continuous.range', 'color.continuous.rescale', 'filter.continuous.range', 'filter.continuous.reset',
  ]),
  setContinuousLogScale: mutates('colors', ['color.continuous.log']),
  setContinuousZeroGray: mutates('colors', ['color.continuous.zero-gray']),
  setContinuousColormap: mutates('colors', ['color.continuous.colormap']),
  getContinuousColormaps: reads(),

  // color-outliers.js
  setOutlierThresholdForActive: mutates('filters', ['filter.outlier']),
  isOutlierFilterEnabledForActiveField: reads(),
  getActiveOutlierQuantiles: reads(),
  getCurrentOutlierThreshold: reads(),

  // filter-manager.js
  computeGlobalVisibility: internal('state-layer'),
  updateFilterSummary: internal('state-layer'),
  getFilterSummaryLines: reads(),
  getActiveFiltersStructured: reads(),
  toggleFilterEnabled: mutates('filters', ['filter.enable']),
  removeFilter: mutates('filters', ['filter.remove']),
  reapplyCategoryColors: internal('state-layer'),
  getLegendModel: reads(),
  getFilterLines: reads(),
  getColorPalette: reads(),
  getColorForCategory: reads(),
  setColorForCategory: mutates('colors', ['color.category']),
  setVisibilityForCategory: mutates('filters', ['filter.category.visibility']),
  setCategoryStates: mutates('filters', ['filter.category.visibility']),
  setCellVisibility: mutates('visibility', ['cells.visibility.set', 'cells.open']),
  setMissingCategoryVisibility: mutates('filters', ['filter.category.missing']),
  setCategoryCellLimit: mutates('filters', ['filter.category.cell-count']),
  showAllCategories: mutates('filters', ['filter.category.all']),
  hideAllCategories: mutates('filters', ['filter.category.all']),
  rgbToCss: reads(),
  clearActiveField: mutates('active-field', ['color.by']),
  getSnapshotPayload: reads(),

  // highlight-manager.js, highlight-accessors.js
  highlightedGroups: reads(),
  getHighlightPages: reads(),
  getActivePageId: reads(),
  getActivePage: reads(),
  getHighlightedCellCountForPage: reads(),
  freeHighlightPageName: reads(),
  defaultHighlightPageName: reads(),
  createHighlightPage: mutates('highlights', ['highlight.page.create', 'cells.open']),
  switchToPage: mutates('highlights', ['highlight.page.switch', 'highlight.page.create', 'highlight.page.combine', 'cells.open']),
  deleteHighlightPage: mutates('highlights', ['highlight.page.delete']),
  renameHighlightPage: mutates('highlights', ['highlight.page.rename', 'cells.open']),
  setHighlightPageColor: mutates('highlights', ['highlight.page.recolor', 'highlight.page.create']),
  getHighlightPageColor: reads(),
  combineHighlightPages: mutates('highlights', ['highlight.page.combine']),
  // The first page, made when none is (a highlight added with no page named).
  ensureHighlightPage: mutates('highlights', ['highlight.cells', 'highlight.category', 'highlight.range']),
  getCellIndicesForCategory: reads(),
  getCellIndicesForRange: reads(),
  clearPreviewHighlight: internal('transient'),
  setPreviewHighlightFromIndices: internal('transient'),
  addHighlightFromCategory: mutates('highlights', ['highlight.category']),
  addHighlightFromRange: mutates('highlights', ['highlight.range']),
  addHighlightDirect: mutates('highlights', ['highlight.cells', 'cells.open']),
  removeHighlightGroup: mutates('highlights', ['highlight.group.remove']),
  toggleHighlightEnabled: mutates('highlights', ['highlight.group.toggle', 'cells.open']),
  replaceHighlightGroupCells: mutates('highlights', ['highlight.category', 'highlight.range']),
  // Only a dataset's publication empties the page shown (`highlight.page.clear` names one).
  clearActivePageHighlights: internal('dataset'),
  clearHighlightPage: mutates('highlights', ['highlight.page.clear']),
  clearHighlightsOnAllPages: mutates('highlights', ['highlight.clear-all']),
  getHighlightedGroups: reads(),
  findHighlightGroupByCategory: reads(),
  getHighlightedCellCount: reads(),
  getTotalHighlightedCellCount: reads(),
  getCellAtScreenPosition: reads(),
});

/**
 * Every key of the viewer's public API (`rendering/viewer.js`, the
 * `publicApi` object `createViewer` returns; `viewerApiNames` reads them).
 */
export const VIEWER_METHODS = Object.freeze({
  // Data the state pushes, and reads of it.
  setData: internal('state-layer'),
  resizeLiveCells: internal('state-layer'),
  updateColors: internal('state-layer'),
  updateTransparency: internal('state-layer'),
  updatePositions: internal('state-layer'),
  getPositions: reads(),
  getColors: reads(),
  getCellPosition: reads(),
  getPointCount: reads(),
  setViewEmbedding: internal('state-layer'),
  getViewLayoutKey: reads(),
  getViewDimension: reads(),
  setViewPositions: internal('state-layer'),
  getViewPositions: reads(),
  getViewColors: reads(),
  getViewTransparency: reads(),
  withBorrowedViewData: reads(),
  updateHighlight: internal('state-layer'),
  setHighlightStyle: internal('diagnostics'),
  getHighlightedCount: reads(),
  pickCellRecordAtScreen: reads(),
  pickReadyCellRecordAtScreen: reads(),
  setFrameInvalidationTracing: internal('diagnostics'),
  getFrameScheduleState: reads(),
  isCameraInMotion: reads(),
  setPulseLayerCaching: internal('diagnostics'),
  getPulseLayerStats: reads(),
  setHighlightStoreDrawing: internal('diagnostics'),
  getHighlightStoreDrawnViewCount: reads(),
  setHighlightAnimationTime: internal('diagnostics'),
  prepareCellPicking: internal('derived'),
  pickCellAtScreen: reads(),

  // The selection tools: a selection in progress is the tool's own until
  // Confirm, which dispatches a highlight action.
  setCellSelectionCallback: internal('wiring'),
  setSelectionStepCallback: internal('wiring'),
  setCellSelectionEnabled: internal('transient'),
  getCellSelectionEnabled: reads(),
  setSelectionPreviewCallback: internal('wiring'),
  getAnnotationState: reads(),
  confirmAnnotationSelection: internal('transient'),
  cancelAnnotationSelection: internal('transient'),
  setViewFieldKindSource: internal('wiring'),
  setSelectMode: internal('transient'),
  getSelectMode: reads(),
  setLassoEnabled: internal('transient'),
  getLassoEnabled: reads(),
  setLassoCallback: internal('wiring'),
  setLassoPreviewCallback: internal('wiring'),
  clearLasso: internal('transient'),
  setLassoStepCallback: internal('wiring'),
  getLassoState: reads(),
  confirmLassoSelection: internal('transient'),
  cancelLassoSelection: internal('transient'),
  restoreLassoState: internal('transient'),
  setProximityEnabled: internal('transient'),
  getProximityEnabled: reads(),
  setProximityCallback: internal('wiring'),
  setProximityPreviewCallback: internal('wiring'),
  setProximityStepCallback: internal('wiring'),
  getProximityState: reads(),
  confirmProximitySelection: internal('transient'),
  cancelProximitySelection: internal('transient'),
  restoreProximityState: internal('transient'),
  setKnnEnabled: internal('transient'),
  getKnnEnabled: reads(),
  setKnnCallback: internal('wiring'),
  setKnnPreviewCallback: internal('wiring'),
  setKnnStepCallback: internal('wiring'),
  setKnnEdgeLoadCallback: internal('wiring'),
  setKnnEdgeReleaseCallback: internal('wiring'),
  setKnnFailureCallback: internal('wiring'),
  getKnnState: reads(),
  loadKnnEdges: internal('derived'),
  clearKnnEdges: internal('derived'),
  isKnnEdgesLoaded: reads(),
  confirmKnnSelection: internal('transient'),
  cancelKnnSelection: internal('transient'),
  restoreKnnState: internal('transient'),
  getUnifiedSelectionState: reads(),
  confirmUnifiedSelection: internal('transient'),
  cancelUnifiedSelection: internal('transient'),
  restoreUnifiedState: internal('transient'),

  // Centroids the state publishes; the two toggles are the focused view's
  // own flags (`views` domain), set by their controls.
  setCentroids: internal('state-layer'),
  setCentroidLabels: internal('state-layer'),
  setShowCentroidPoints: mutates('views', SETTING),
  setShowCentroidLabels: mutates('views', SETTING),
  getCentroidFlags: reads(),

  // Render settings: each is a settings control's (`setting.set`, recorded by
  // observation), some put back by Reset (`display.reset`).
  setPointSize: mutates('settings', SETTING),
  setSizeAttenuation: mutates('settings', SETTING_OR_RESET),
  setLightingStrength: mutates('settings', SETTING_OR_RESET),
  setFogDensity: mutates('settings', SETTING_OR_RESET),
  setBackground: mutates('settings', SETTING_OR_RESET),
  getBackdropLookDiagnostics: reads(),
  setBackdropAmbientMotion: internal('diagnostics'),
  // The part of the canvas the sidebar covers: the page's layout, followed.
  setViewportLeftOcclusionRatio: internal('derived'),
  setRenderMode: mutates('settings', SETTING),
  setHighlightRenderFailureHandler: internal('wiring'),
  setSmokeRenderFailureHandler: internal('wiring'),
  setSmokeSourceChangeHandler: internal('wiring'),
  setVelocityRenderFailureHandler: internal('wiring'),

  // Navigation: the mode is the camera's (`camera` domain); its settings are
  // controls (`setting.set`).
  setNavigationMode: mutates('camera', ['camera.navigation.set', 'display.reset']),
  getNavigationMode: reads(),
  setLookSensitivity: mutates('settings', SETTING),
  setMoveSpeed: mutates('settings', SETTING),
  setInvertLookY: mutates('settings', SETTING_OR_RESET),
  setInvertLookX: mutates('settings', SETTING_OR_RESET),
  setOrbitInvertRotation: mutates('settings', SETTING_OR_RESET),
  setPlanarZoomToCursor: mutates('settings', SETTING_OR_RESET),
  setPlanarInvertAxes: mutates('settings', SETTING_OR_RESET),
  setOrbitKeySpeed: mutates('settings', SETTING),
  setPlanarPanSpeed: mutates('settings', SETTING),
  // A pointer capture is not a preference (`ui-controls.js` DOMAIN_OWNED_IDS).
  setPointerLockEnabled: internal('transient'),
  setPointerLockChangeHandler: internal('wiring'),
  setProjectilesEnabled: mutates('settings', SETTING_OR_RESET),
  isProjectileSpatialIndexReady: reads(),
  getProjectilePositions: reads(),
  setShowOrbitAnchor: mutates('settings', SETTING_OR_RESET),
  getShowOrbitAnchor: reads(),

  // Smoke: the volume is built from the data; its looks are settings.
  clearSmokeVolume: internal('derived'),
  buildSmokeVolumeGPU: internal('derived'),
  getCellLayerColors: reads(),
  hasSmokeVolume: reads(),
  getSmokeSupport: reads(),
  setSmokeParams: mutates('settings', SETTING),
  setCloudResolutionScale: mutates('settings', SETTING),
  getCloudResolutionScale: reads(),
  setNoiseTextureResolution: mutates('settings', SETTING),
  getNoiseTextureResolution: reads(),
  hasPendingSmokeNoiseGeneration: reads(),
  hasSmokeNoiseTextures: reads(),

  // Connectivity: the edges are built from the data; showing them, their
  // looks and how many are drawn are settings.
  setShowConnectivity: mutates('settings', SETTING),
  getShowConnectivity: reads(),
  onFullDetailFrameCost: internal('wiring'),
  onPerformanceSettingsChanged: internal('wiring'),
  setConnectivityLineWidth: mutates('settings', SETTING),
  getConnectivityLineWidth: reads(),
  setConnectivityAlpha: mutates('settings', SETTING),
  getConnectivityAlpha: reads(),
  setConnectivityColor: mutates('settings', SETTING),
  getConnectivityColor: reads(),
  hasConnectivityData: reads(),
  getEdgeCount: reads(),
  setupEdgesV2: internal('derived'),
  updateEdgeVisibilityV2FromLod: internal('derived'),
  updateEdgeVisibilityV2ForViewFromLod: internal('derived'),
  refreshEdgeSelectionForView: internal('derived'),
  setEdgeVisibleTarget: mutates('settings', SETTING),
  getEdgeSelectionStatsForView: reads(),
  onConnectivityVisibleCount: internal('wiring'),
  isUsingInstancedEdges: reads(),
  clearEdgesV2: internal('derived'),
  setupEdgesV2ForView: internal('derived'),
  hasConnectivityView: reads(),
  deleteConnectivityView: internal('derived'),
  getConnectivityMemoryStats: reads(),

  // Cameras and views.
  resetCamera: mutates('camera', ['camera.reset', 'display.reset']),
  getCameraState: reads(),
  setCameraState: mutates('camera', ['camera.set']),
  stopInertia: internal('transient'),
  setCamerasLocked: mutates('views', ['view.cameras.link']),
  getCameraLinkGroups: reads(),
  getCamerasLocked: reads(),
  // The views' titles, drawn from the views list (`app/actions/targets/views.js`).
  setViewTitlePrefixes: internal('derived'),
  releaseRepresentationGeometry: internal('derived'),
  releaseRetainedGeometry: internal('derived'),
  getRetainedGeometryBytes: reads(),
  getFocusedViewId: reads(),
  getViewCameraState: reads(),
  setViewCameraState: mutates('camera', ['camera.set', 'camera.reset']),
  getViewNavigationMode: reads(),
  setViewNavigationMode: mutates('camera', ['camera.navigation.set']),
  setViewFocusHandler: internal('wiring'),
  setNavigationModeChangeHandler: internal('wiring'),
  setLiveViewLabel: internal('state-layer'),
  getLiveViewLabel: reads(),
  // The name a person or an agent gave a view (`app/actions/targets/views.js`).
  setViewName: mutates('views', ['view.rename', 'view.keep']),
  getViewName: reads(),
  createSnapshotView: mutates('views', ['view.keep']),
  updateSnapshotAttributes: internal('state-layer'),
  removeSnapshotView: mutates('views', ['view.remove', 'view.clear']),
  clearSnapshotViews: mutates('views', ['view.clear']),
  getSnapshotViews: reads(),
  hasSnapshots: reads(),
  setViewLayout: mutates('views', ['view.layout.set', 'view.keep', 'view.remove', 'view.clear', 'view.focus']),
  getViewLayout: reads(),
  getPresentedLayout: reads(),
  onPresentedLayoutChange: internal('wiring'),
  setLiveViewHidden: mutates('views', ['view.remove', 'view.keep', 'view.clear']),
  getLiveViewHidden: reads(),

  // The renderer, its quality settings and its lifecycle.
  getGLContext: reads(),
  getHPRenderer: reads(),
  whenGpuIdle: reads(),
  prepareDataStores: internal('derived'),
  releasePreparedDataStores: internal('derived'),
  isWebGL2: reads(),
  setAntialiasing: mutates('settings', SETTING),
  getAntialiasing: reads(),
  isAntialiasingAvailable: reads(),
  getAntialiasingSampleCount: reads(),
  setVectorFieldOverlayEnabled: mutates('settings', SETTING),
  setVectorFieldConfig: mutates('settings', SETTING),
  setActiveVectorField: mutates('settings', SETTING),
  setVectorFieldData: internal('state-layer'),
  hasVectorFieldForLayout: reads(),
  resetVectorFieldOverlay: internal('state-layer'),
  getRenderState: reads(),
  getCameraParams: reads(),
  getViewRenderState: reads(),
  getPresentedViewState: reads(),
  setShaderQuality: mutates('settings', SETTING),
  setFrustumCulling: mutates('settings', SETTING),
  setCellPriority: internal('dataset'),
  setAdaptiveLOD: mutates('settings', SETTING),
  measureFullDetailFrameCost: internal('diagnostics'),
  verifyFullDetailFrameCost: internal('diagnostics'),
  setForceLOD: mutates('settings', SETTING),
  getLODLevelCount: reads(),
  hasRendererStats: reads(),
  getRendererStats: reads(),
  debugRendererStatus: reads(),
  getCurrentLodMembership: reads(),
  getCurrentLODLevel: reads(),
  isPresentedGeometrySettled: reads(),
  onLodChanged: internal('wiring'),
  onPresentedViewStateChanged: internal('wiring'),
  start: internal('lifecycle'),
  pause: internal('lifecycle'),
  resume: internal('lifecycle'),
  isPaused: reads(),
  isDisposed: reads(),
  isContextLost: reads(),
  onGraphicsReset: internal('wiring'),
  isDisposalSettled: reads(),
  dispose: internal('lifecycle'),
});

const SETTINGS_RECORDED = 'owns these settings controls: it applies a person\'s change, which is recorded by observation (`setting.set`, `ui/modules/settings-actions.js`)';

/**
 * The modules that may call `mutates` methods, with the methods each may
 * call and why: an action's implementation (it is what the action does), a
 * domain owner (it puts a value back), an observation recorder (it applies a
 * setting or a camera gesture that is recorded as it happens), a dataset's
 * publication (the state a history starts from). A `prefix` entry covers a
 * whole layer. Any other call is a control changing state outside the
 * action layer.
 *
 * @type {ReadonlyArray<{module?: string, prefix?: string, methods?: string[], why: string}>}
 */
export const MUTATION_OWNERS = Object.freeze([
  {
    prefix: 'assets/js/app/state/',
    why: 'the state layer implements these methods, its domain owners (`domains/`) put values back through them, and its actions (`actions/field-actions.js`) are the field, color, filter and mapping actions\' implementations',
  },
  {
    prefix: 'assets/js/rendering/',
    why: 'the viewer implements its API, and its own parts call it',
  },
  {
    module: 'assets/js/app/main.js',
    methods: [
      'clearActiveField', 'clearSnapshotViews', 'setViewName', 'setShowConnectivity', 'setConnectivityColor', 'setConnectivityAlpha',
      'setConnectivityLineWidth', 'setEdgeVisibleTarget',
    ],
    why: 'publishes a dataset (no field shown, no kept view, the live view unnamed: the state its history starts from) and owns the connectivity controls, whose changes are recorded by observation (`setting.set`)',
  },
  {
    module: 'assets/js/app/cell-subset-carry.js',
    methods: [
      'ensureHighlightPage', 'createHighlightPage', 'renameHighlightPage', 'switchToPage', 'addHighlightDirect',
      'toggleHighlightEnabled', 'upsertUserDefinedCategoricalField', 'upsertUserDefinedContinuousField', 'setCellVisibility',
    ],
    why: 'carries what was made (highlights, user fields, hidden cells) by original cell position across a reading of other cells: part of `cells.open` and of the `cells` domain\'s restore',
  },
  {
    module: 'assets/js/app/open-cells-resize.js',
    methods: ['setActiveField', 'setActiveVarField'],
    why: 'reads the dataset again on other cells (`cells.open`, the `cells` domain\'s restore) and shows the field that was shown again',
  },
  {
    module: 'assets/js/app/view-snapshot-publication.js',
    methods: ['createSnapshotView', 'createViewFromSource', 'applySnapshotConfigToView', 'removeView', 'removeSnapshotView', 'clearSnapshotViews'],
    why: 'publishes and removes kept views: what `view.keep`, `view.remove` and `view.clear` do (`ui/modules/view-controls.js` provides them)',
  },
  {
    module: 'assets/js/app/ui/modules/view-controls.js',
    methods: ['setActiveView', 'setViewLayout', 'setLiveViewHidden', 'setCamerasLocked', 'setViewName', 'setCellVisibility'],
    why: 'implements the view actions (`view.*`) and `cells.visibility.set`; a click on a pane, which the viewer focuses itself, is recorded by observation (`view.focus`)',
  },
  {
    module: 'assets/js/app/ui/modules/representation-controls.js',
    methods: ['setViewEmbeddingRef', 'showDefaultRepresentation', 'cycleRepresentation'],
    why: 'implements `view.embedding.set`, `view.embedding.default` and `view.embedding.cycle`',
  },
  {
    module: 'assets/js/app/ui/modules/field-selector.js',
    methods: ['setActiveField', 'clearActiveField', 'duplicateField'],
    why: 'implements `color.by` (reading a field before showing it) and `field.duplicate`',
  },
  {
    module: 'assets/js/app/ui/modules/field-selector-gene-expression.js',
    methods: ['setActiveVarField'],
    why: 'shows a gene: the gene half of `color.by`, which the field selector provides',
  },
  {
    module: 'assets/js/app/ui/modules/highlight/highlight-actions.js',
    methods: [
      'ensureHighlightPage', 'createHighlightPage', 'setHighlightPageColor', 'switchToPage', 'renameHighlightPage',
      'deleteHighlightPage', 'combineHighlightPages', 'clearHighlightPage', 'clearHighlightsOnAllPages',
      'addHighlightDirect', 'addHighlightFromCategory', 'addHighlightFromRange', 'toggleHighlightEnabled',
      'removeHighlightGroup', 'replaceHighlightGroupCells',
    ],
    why: 'implements the highlight actions (`highlight.*`)',
  },
  {
    module: 'assets/js/app/ui/modules/highlight/highlight-pages-ui.js',
    methods: ['ensureHighlightPage'],
    why: 'makes the first page as the Highlighting panel starts, before any dataset is open; a dataset\'s publication replaces the pages, so no history holds it',
  },
  {
    module: 'assets/js/app/ui/modules/camera-controls.js',
    methods: ['setNavigationMode', 'setViewNavigationMode', 'setViewCameraState', 'resetCamera', 'setProjectilesEnabled'],
    why: 'implements `camera.set`, `camera.reset` and `camera.navigation.set` (a camera gesture is recorded by observation when the camera settles) and owns the projectiles control (recorded by observation, `setting.set`)',
  },
  {
    module: 'assets/js/app/ui/modules/cinematic-camera/playback-controller.js',
    methods: ['setCameraState'],
    why: 'plays the camera path: the camera it ends on is recorded by observation when it settles (`camera.set`, `camera-controls.js`)',
  },
  {
    module: 'assets/js/app/ui/modules/state/tour.js',
    methods: ['setCameraState'],
    why: 'the guided tour flies to each step\'s camera after the history shows that step, and ends on the camera the history shows: nothing to record',
  },
  {
    module: 'assets/js/app/ui/modules/visualization-reset.js',
    methods: [
      'resetCamera', 'setBackground', 'setNavigationMode', 'setInvertLookY', 'setInvertLookX', 'setProjectilesEnabled',
      'setOrbitInvertRotation', 'setShowOrbitAnchor', 'setPlanarZoomToCursor', 'setPlanarInvertAxes', 'setLightingStrength',
      'setFogDensity', 'setSizeAttenuation',
    ],
    why: 'implements `display.reset`',
  },
  {
    module: 'assets/js/app/ui/modules/render-controls.js',
    methods: [
      'setPointSize', 'setRenderMode', 'setSmokeParams', 'setCloudResolutionScale', 'setNoiseTextureResolution',
      'setBackground', 'setLightingStrength', 'setFogDensity', 'setSizeAttenuation', 'setShaderQuality',
      'setFrustumCulling', 'setAdaptiveLOD', 'setForceLOD', 'setAntialiasing',
    ],
    why: SETTINGS_RECORDED,
  },
  {
    module: 'assets/js/app/ui/modules/navigation-settings.js',
    methods: [
      'setOrbitKeySpeed', 'setPlanarPanSpeed', 'setLookSensitivity', 'setMoveSpeed', 'setInvertLookY', 'setInvertLookX',
      'setOrbitInvertRotation', 'setShowOrbitAnchor', 'setPlanarZoomToCursor', 'setPlanarInvertAxes',
    ],
    why: SETTINGS_RECORDED,
  },
  {
    module: 'assets/js/app/ui/modules/legend-renderer.js',
    methods: ['setShowCentroidPoints', 'setShowCentroidLabels'],
    why: 'owns the centroid toggles (the focused view\'s own flags, `views` domain): it applies a person\'s change, which is recorded by observation (`setting.set`, `ui/modules/settings-actions.js`)',
  },
  {
    module: 'assets/js/app/ui/modules/velocity-overlay-controls.js',
    methods: ['setVectorFieldOverlayEnabled', 'setVectorFieldConfig', 'setActiveVectorField'],
    why: SETTINGS_RECORDED,
  },
  {
    module: 'assets/js/app/ui/modules/benchmark/matrix-runner.js',
    methods: ['setCameraState', 'setAdaptiveLOD', 'setFrustumCulling', 'setForceLOD'],
    why: 'the benchmark harness (a developer tool, never a person\'s step) drives the camera and the renderer\'s quality through the scenarios it measures',
  },
  {
    module: 'assets/js/app/ui/modules/benchmark/render-probes.js',
    methods: ['setCameraState'],
    why: 'the benchmark\'s render probes (a developer tool, never a person\'s step) move the camera through the frames they measure',
  },
]);

/**
 * Calls whose method name is a `mutates` method's but whose receiver is
 * another object: matched by module, receiver (the name before the dot) and
 * method, each with what the object is.
 *
 * @type {ReadonlyArray<{module: string, receiver: string, methods: string[], why: string}>}
 */
export const NAME_COLLISIONS = Object.freeze([
  {
    module: 'assets/js/data/dimension-manager.js',
    receiver: 'this',
    methods: ['setViewLayout'],
    why: 'the dimension manager\'s own record of the layout each view shows',
  },
  {
    module: 'assets/js/app/main.js',
    receiver: 'ui',
    methods: ['cycleRepresentation'],
    why: 'the interface\'s own cycle (`ui-coordinator.js` → `representation-controls.js` `cycle`), which dispatches `view.embedding.cycle`: the keys 1, 2 and 3',
  },
  {
    module: 'assets/js/dev/benchmark.js',
    receiver: 'renderer',
    methods: ['setAdaptiveLOD', 'setFrustumCulling', 'setForceLOD'],
    why: 'the high-performance renderer (`rendering/high-perf-renderer.js`) the developer benchmark measures, not the viewer',
  },
]);

/**
 * The names of the viewer's public API in `rendering/viewer.js`'s source:
 * the keys of the object literal `const publicApi = {…}` (methods,
 * shorthand properties, `key: value` entries), read with strings,
 * templates, comments and regular expressions skipped, so a key is found
 * whatever its indentation. A spread or a computed key cannot be read and
 * is refused, naming it.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function viewerApiNames(source) {
  const marker = 'const publicApi = {';
  const at = source.indexOf(marker);
  if (at < 0) throw new Error('rendering/viewer.js no longer declares `const publicApi = {`: read the viewer API where it is now');
  let i = at + marker.length;
  let depth = 1;
  let expectKey = true;
  // What came before the next token: whether a `/` there starts a regular expression.
  let regexAllowed = true;
  const names = [];
  const isIdStart = c => /[A-Za-z_$]/.test(c);
  const isId = c => /[\w$]/.test(c);

  function skipQuoted(j, quote) {
    for (j += 1; j < source.length; j++) {
      if (source[j] === '\\') { j++; continue; }
      if (source[j] === quote) return j + 1;
    }
    throw new Error('rendering/viewer.js: an unterminated string in publicApi');
  }
  function skipTemplate(j) {
    for (j += 1; j < source.length; j++) {
      if (source[j] === '\\') { j++; continue; }
      if (source[j] === '`') return j + 1;
      if (source[j] === '$' && source[j + 1] === '{') j = skipCode(j + 2, '}') - 1;
    }
    throw new Error('rendering/viewer.js: an unterminated template in publicApi');
  }
  function skipRegex(j) {
    let inClass = false;
    for (j += 1; j < source.length; j++) {
      const c = source[j];
      if (c === '\\') { j++; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        j++;
        while (j < source.length && /[a-z]/.test(source[j])) j++;
        return j;
      }
      else if (c === '\n') throw new Error('rendering/viewer.js: an unterminated regular expression in publicApi');
    }
    return j;
  }
  /** Skip code up to its matching `close`; returns the index after it. */
  function skipCode(j, close) {
    let level = 0;
    let allowRegex = true;
    while (j < source.length) {
      const c = source[j];
      if (/\s/.test(c)) { j++; continue; }
      if (c === '/' && source[j + 1] === '/') { j = source.indexOf('\n', j); if (j < 0) return source.length; continue; }
      if (c === '/' && source[j + 1] === '*') { j = source.indexOf('*/', j + 2) + 2; continue; }
      if (c === '"' || c === "'") { j = skipQuoted(j, c); allowRegex = false; continue; }
      if (c === '`') { j = skipTemplate(j); allowRegex = false; continue; }
      if (c === '/' && allowRegex) { j = skipRegex(j); allowRegex = false; continue; }
      if (isId(c)) {
        let k = j;
        while (k < source.length && isId(source[k])) k++;
        allowRegex = /^(return|typeof|case|in|of|new|delete|void|throw|yield|await|else|do)$/.test(source.slice(j, k));
        j = k;
        continue;
      }
      if ('([{'.includes(c)) level++;
      if (')]}'.includes(c)) {
        if (level === 0 && c === close) return j + 1;
        level--;
      }
      allowRegex = !')]}'.includes(c);
      j++;
    }
    throw new Error('rendering/viewer.js: publicApi is not closed');
  }

  while (i < source.length && depth > 0) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i + 2) + 2; continue; }
    if (depth === 1 && expectKey) {
      if (c === '}') { depth = 0; break; }
      if (source.startsWith('...', i)) throw new Error('rendering/viewer.js: publicApi spreads another object; its names cannot be read');
      if (c === '[') throw new Error('rendering/viewer.js: publicApi has a computed key; its names cannot be read');
      if (c === '"' || c === "'") throw new Error('rendering/viewer.js: publicApi has a quoted key; write it as a plain name');
      if (c === '*') { i++; continue; }
      if (!isIdStart(c)) throw new Error(`rendering/viewer.js: unexpected "${c}" where a publicApi key starts`);
      let k = i;
      while (k < source.length && isId(source[k])) k++;
      let word = source.slice(i, k);
      // `async name(`, `get name(`, `set name(`: the modifier, then the name.
      let rest = k;
      while (/\s/.test(source[rest])) rest++;
      if (['async', 'get', 'set'].includes(word) && isIdStart(source[rest])) {
        let end = rest;
        while (end < source.length && isId(source[end])) end++;
        word = source.slice(rest, end);
        k = end;
      }
      names.push(word);
      expectKey = false;
      regexAllowed = false;
      i = k;
      continue;
    }
    if (c === '"' || c === "'") { i = skipQuoted(i, c); regexAllowed = false; continue; }
    if (c === '`') { i = skipTemplate(i); regexAllowed = false; continue; }
    if (c === '/' && regexAllowed) { i = skipRegex(i); regexAllowed = false; continue; }
    if (isId(c)) {
      let k = i;
      while (k < source.length && isId(source[k])) k++;
      regexAllowed = /^(return|typeof|case|in|of|new|delete|void|throw|yield|await|else|do)$/.test(source.slice(i, k));
      i = k;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (depth === 1 && c === ',') expectKey = true;
    regexAllowed = !')]}'.includes(c);
    i++;
  }
  if (depth !== 0) throw new Error('rendering/viewer.js: publicApi is not closed');
  return names;
}

/** The names `table` does not classify. */
export function unclassified(names, table) {
  return [...names].filter(name => !Object.hasOwn(table, name));
}

/** The classifications in `table` of names that are no longer there. */
export function staleClassifications(names, table) {
  const present = new Set(names);
  return Object.keys(table).filter(name => !present.has(name));
}

/** The names of `table` that mutate a domain value. */
export function mutatingNames(table) {
  return Object.keys(table).filter(name => table[name].kind === 'mutates');
}
