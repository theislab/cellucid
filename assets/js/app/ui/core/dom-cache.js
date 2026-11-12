/**
 * @fileoverview DOM cache helpers for the app UI.
 *
 * Collects commonly used DOM element references once at startup so UI modules
 * can avoid repeated `querySelector` calls and keep selectors centralized.
 *
 * This module returns a nested object keyed by UI domain (field selector,
 * highlights, filters, rendering, camera, etc.). Modules should only depend on
 * the subset they need.
 *
 * @module ui/core/dom-cache
 */

/**
 * @typedef {Document|HTMLElement} DomRoot
 */

/**
 * Collect DOM references for UI modules.
 *
 * Pass `document` to collect global elements (recommended). Passing a narrower
 * container is supported, but `getElementById` is only available on `Document`.
 *
 * @param {DomRoot} root
 */
export function collectDOMReferences(root) {
  const safeRoot = root || (typeof document !== 'undefined' ? document : null);
  if (!safeRoot) {
    return /** @type {const} */ ({});
  }

  const $ = (sel) => safeRoot.querySelector?.(sel) || null;
  const $$ = (sel) => Array.from(safeRoot.querySelectorAll?.(sel) || []);
  const byId = (id) => {
    if (safeRoot.getElementById) return safeRoot.getElementById(id);
    return $(`#${CSS?.escape ? CSS.escape(id) : id}`);
  };

  return {
    stats: {
      el: byId('stats'),
    },

    // The Dataset box (ui/modules/dataset-card.js).
    datasetCard: {
      root: byId('dataset-info'),
      spinner: byId('dataset-spinner'),
      name: byId('dataset-name'),
      summary: byId('dataset-summary'),
      cells: byId('dataset-cells'),
      genes: byId('dataset-genes'),
      origin: byId('dataset-origin'),
      conversion: byId('dataset-conversion'),
      descriptionBlock: byId('dataset-description-block'),
      description: byId('dataset-description'),
      descriptionToggle: byId('dataset-description-toggle'),
      read: byId('dataset-read'),
      details: byId('dataset-details'),
      detailsList: byId('dataset-details-list'),
    },

    dataset: {
      select: byId('dataset-select'),

      userDataOpenBtn: byId('user-data-open-btn'),
      userDataOpenMenu: byId('user-data-open-menu'),
      userDataFileItem: byId('user-data-file-item'),
      userDataFolderItem: byId('user-data-folder-item'),
      userDataFileInput: byId('user-data-file-input'),
      userDataFolderInput: byId('user-data-folder-input'),
      datasetDropOverlay: byId('dataset-drop-overlay'),

      dataAddressInput: byId('data-address'),
      dataAddressOpenBtn: byId('data-address-open-btn'),
      remoteDisconnectBtn: byId('remote-disconnect-btn'),
      remoteDisconnectContainer: byId('remote-disconnect-container'),
      remoteConnectionTarget: byId('remote-connection-target'),
      dataLinkDisconnectBtn: byId('data-link-disconnect-btn'),
      dataLinkDisconnectContainer: byId('data-link-disconnect-container'),
      dataLinkConnectionTarget: byId('data-link-connection-target'),
    },

    subsample: {
      root: byId('subsample-block'),
      slider: byId('subsample-slider'),
      percent: byId('subsample-percent'),
      count: byId('subsample-count'),
      settings: byId('subsample-settings'),
      method: byId('subsample-method'),
      seed: byId('subsample-seed'),
      fieldRow: byId('subsample-field-row'),
      field: byId('subsample-field'),
      balanced: byId('subsample-balanced'),
      embeddingRow: byId('subsample-embedding-row'),
      embedding: byId('subsample-embedding'),
      actions: byId('subsample-actions'),
      apply: byId('subsample-apply'),
      notice: byId('subsample-notice'),
      details: byId('subsample-details'),
      detailsList: byId('subsample-details-list'),
      openAll: byId('subsample-open-all'),
      copyLink: byId('subsample-copy-link'),
      useBlocks: byId('subsample-use-blocks'),
    },

    geneRead: {
      root: byId('gene-read-block'),
      slider: byId('gene-read-slider'),
      percent: byId('gene-read-percent'),
      status: byId('gene-read-status'),
      actions: byId('gene-read-actions'),
      action: byId('gene-read-action'),
    },

    keptStores: {
      root: byId('kept-stores-line'),
      text: byId('kept-stores-text'),
      manage: byId('kept-stores-manage-btn'),
    },

    keptStoresDialog: {
      dialog: byId('kept-stores-dialog'),
      list: byId('kept-stores-list'),
      empty: byId('kept-stores-empty'),
      status: byId('kept-stores-status'),
      removeSelected: byId('kept-stores-remove-selected'),
      removeAll: byId('kept-stores-remove-all'),
      where: byId('kept-stores-where'),
      persist: byId('kept-stores-persist'),
    },

    // My datasets (ui/modules/my-datasets/): its menu under Open data, and All….
    myDatasets: {
      menu: {
        root: byId('my-datasets-block'),
        button: byId('my-datasets-btn'),
        menu: byId('my-datasets-menu'),
        status: byId('my-datasets-status'),
      },
      dialog: {
        dialog: byId('my-datasets-dialog'),
        filter: byId('my-datasets-filter'),
        status: byId('my-datasets-dialog-status'),
        list: byId('my-datasets-list'),
        empty: byId('my-datasets-empty'),
        exportButton: byId('my-datasets-export-btn'),
        importButton: byId('my-datasets-import-btn'),
        importInput: byId('my-datasets-import-input'),
        exportPanel: byId('my-datasets-export'),
      },
      fileItem: byId('user-data-file-item'),
      folderItem: byId('user-data-folder-item'),
    },

    session: {
      loadBtn: byId('load-state-btn'),
    },

    // Agents › Claude and ChatGPT and its dialogs (app/agent/connect/).
    agentConnect: {
      section: byId('agents-section'),
      status: byId('agent-connect-status'),
      address: byId('agent-connector-address'),
      copy: byId('agent-connector-copy'),
      codeForm: byId('agent-connect-code-form'),
      code: byId('agent-connect-code'),
      codeStatus: byId('agent-connect-code-status'),
      manage: byId('agent-connections-open-btn'),
      approval: {
        dialog: byId('agent-approval-dialog'),
        title: byId('agent-approval-title'),
        who: byId('agent-approval-who'),
        where: byId('agent-approval-where'),
        warnings: byId('agent-approval-warnings'),
        code: byId('agent-approval-code'),
        status: byId('agent-approval-status'),
        allow: byId('agent-approval-allow'),
        deny: byId('agent-approval-deny'),
      },
      connections: {
        dialog: byId('agent-connections-dialog'),
        status: byId('agent-connections-status'),
        list: byId('agent-connections-list'),
        empty: byId('agent-connections-empty'),
        forget: byId('agent-forget-btn'),
        forgetConfirm: byId('agent-forget-confirm'),
        forgetYes: byId('agent-forget-yes'),
        forgetNo: byId('agent-forget-no'),
      },
    },

    // The State panel: the session's Share and Load, the history of the
    // dataset shown as a branch graph, and its dialogs (ui/modules/state/).
    state: {
      section: byId('state-section'),
      shareButton: byId('history-share-btn'),
      loadButton: byId('history-load-btn'),
      searchButton: byId('history-search-btn'),
      undoButton: byId('history-undo-btn'),
      redoButton: byId('history-redo-btn'),
      settingsButton: byId('history-settings-btn'),
      menuButton: byId('history-menu-btn'),
      menu: byId('history-menu'),
      settings: byId('history-settings'),
      search: byId('history-search'),
      searchInput: byId('history-search-input'),
      filterButton: byId('history-filter-btn'),
      recording: byId('history-recording'),
      branchButton: byId('history-branch-btn'),
      status: byId('history-status'),
      announce: byId('history-announce'),
      staleButton: byId('history-stale-btn'),
      memoryButton: byId('history-memory-btn'),
      pendingCancel: byId('history-pending-cancel'),
      branches: byId('history-branches'),
      banner: byId('history-banner'),
      graph: byId('history-graph'),
      where: byId('history-where'),
      diffDialog: byId('history-diff-dialog'),
      diffFrom: byId('history-diff-from'),
      diffTo: byId('history-diff-to'),
      diffStatus: byId('history-diff-status'),
      diffList: byId('history-diff-list'),
      savedDialog: byId('saved-states-dialog'),
      savedList: byId('saved-states-list'),
      savedEmpty: byId('saved-states-empty'),
      savedStatus: byId('saved-states-status'),
      savedName: byId('saved-states-name'),
      savedContent: byId('saved-states-content'),
      savedSaveAs: byId('saved-states-save-as'),
      savedReplayFile: byId('saved-states-replay-file'),
      savedOpenFile: byId('load-state-btn'),
      shareDialog: byId('history-share-dialog'),
      deletedDialog: byId('history-deleted-dialog'),
      deletedStatus: byId('history-deleted-status'),
      deletedList: byId('history-deleted-list'),
      deletedEmpty: byId('history-deleted-empty'),
      mapDialog: byId('history-map-dialog'),
      replayDialog: byId('history-replay-dialog'),
      memoryDialog: byId('history-memory-dialog'),
      reportDialog: byId('history-report-dialog'),
      reportPictures: byId('history-report-pictures'),
      reportSteps: byId('history-report-steps'),
      reportOpen: byId('history-report-open'),
    },

    // The agents' dock at the foot of the plot: the presence and the chat
    // bar (app/agent/).
    agent: {
      dock: byId('agent-dock'),
      dockGrip: byId('agent-dock-grip'),
      presence: byId('agent-presence'),
      toggle: byId('agent-chat-toggle'),
      toggleLabel: byId('agent-chat-toggle-label'),
      panel: byId('agent-chat-panel'),
      status: byId('agent-chat-status'),
      newButton: byId('agent-chat-new'),
      exportButton: byId('agent-chat-export'),
      settingsButton: byId('agent-chat-settings-btn'),
      collapseButton: byId('agent-chat-collapse'),
      settings: byId('agent-chat-settings'),
      provider: byId('agent-chat-provider'),
      keyRow: byId('agent-chat-key-row'),
      keyLabel: byId('agent-chat-key-label'),
      key: byId('agent-chat-key'),
      remember: byId('agent-chat-remember'),
      forget: byId('agent-chat-forget'),
      keyLink: byId('agent-chat-key-link'),
      model: byId('agent-chat-model'),
      effortRow: byId('agent-chat-effort-row'),
      effort: byId('agent-chat-effort'),
      permissionsSummary: byId('agent-chat-permissions-summary'),
      permissionsChange: byId('agent-chat-permissions-change'),
      connectPermissionsSummary: byId('agent-connect-permissions-summary'),
      connectPermissionsChange: byId('agent-connect-permissions-change'),
      instructions: byId('agent-chat-instructions'),
      budget: byId('agent-chat-budget'),
      cacheRow: byId('agent-chat-cache-row'),
      cache: byId('agent-chat-cache'),
      settingsStatus: byId('agent-chat-settings-status'),
      usage: byId('agent-chat-usage'),
      log: byId('agent-chat-log'),
      tray: byId('agent-chat-tray'),
      form: byId('agent-chat-form'),
      input: byId('agent-chat-input'),
      send: byId('agent-chat-send'),
      stop: byId('agent-chat-stop'),
      permissionsDialog: byId('agent-permissions-dialog'),
      permissionsBody: byId('agent-permissions-body'),
    },

    fieldSelector: {
      categoricalSelect: byId('categorical-field'),
      categoricalCopyBtn: byId('copy-categorical-field'),
      categoricalGroupBtn: byId('group-categorical-field'),
      categoricalRenameBtn: byId('rename-categorical-field'),
      categoricalDeleteBtn: byId('delete-categorical-field'),
      categoricalClearBtn: byId('clear-categorical-field'),

      continuousSelect: byId('continuous-field'),
      continuousCopyBtn: byId('copy-continuous-field'),
      continuousRenameBtn: byId('rename-continuous-field'),
      continuousDeleteBtn: byId('delete-continuous-field'),
      continuousClearBtn: byId('clear-continuous-field'),

      geneContainer: byId('gene-expression-container'),
      geneSearch: byId('gene-expression-search'),
      geneDropdown: byId('gene-expression-dropdown'),
      geneCopyBtn: byId('copy-gene-expression'),
      geneRenameBtn: byId('rename-gene-expression'),
      geneDeleteBtn: byId('delete-gene-expression'),
      geneClearBtn: byId('clear-gene-expression'),

      categoryBuilderContainer: byId('category-builder-container'),
      deletedFieldsSection: byId('deleted-fields-section'),
    },

    display: {
      optionsContainer: byId('display-options-container'),
      legendEl: byId('legend'),

      outlierFilterContainer: byId('outlier-filter-container'),
      outlierFilterInput: byId('outlier-filter'),
      outlierFilterDisplay: byId('outlier-filter-display'),
      outlierFilterNote: byId('outlier-filter-note'),
      outlierFilterProgress: byId('outlier-filter-progress'),
      outlierFilterProgressBar: byId('outlier-filter-progress-bar'),
      outlierFilterAction: byId('outlier-filter-action'),

      centroidControls: byId('centroid-controls'),
      centroidPointsCheckbox: byId('toggle-centroid-points'),
      centroidLabelsCheckbox: byId('toggle-centroid-labels'),
    },

    filter: {
      countEl: byId('filter-count'),
      activeFiltersEl: byId('active-filters'),
    },

    // The exports of the highlighted cells and of the selected fields
    // (ui/modules/cell-exports-ui.js).
    cellExports: {
      highlightsCsvButton: byId('export-highlights-csv'),
      highlightsH5adButton: byId('export-highlights-h5ad'),
      categoricalExportButton: byId('export-categorical-field'),
      continuousExportButton: byId('export-continuous-field'),
      categoricalSelect: byId('categorical-field'),
      continuousSelect: byId('continuous-field'),
    },

    // The Highlighting panel and the selection bar over the plot (#select-bar)
    // show the same controls; every list below holds the panel's first.
    highlight: {
      countEls: [byId('highlight-count'), byId('select-bar-count')],
      groupsEl: byId('highlighted-groups-list'),
      pagesTabsEl: byId('highlight-pages-tabs'),
      addPageBtn: byId('add-highlight-page'),
      clearButtons: [byId('clear-all-highlights'), byId('select-bar-clear')],
      modeButtons: $$('.highlight-mode-btn'),
      modeDescription: byId('highlight-mode-description'),
      // Marked, not matched by class: `.switch` is a shared component and
      // not every switch is Select mode.
      selectModeSwitches: $$('[data-select-mode-switch]'),
      selectCombineGroups: $$('.select-combine'),
      selectCombineButtons: $$('.select-combine .segmented-btn'),
      selectBarSteps: byId('select-bar-steps'),
      selectBarStepButtons: $$('#select-bar-steps [data-step-action]'),
    },

    communityAnnotation: {
      section: byId('community-annotation-section'),
      container: byId('community-annotation-controls'),
    },

    render: {
      backgroundSelect: byId('background-select'),
      renderModeSelect: byId('render-mode'),
      renderModeMaturityTag: byId('render-mode-maturity-tag'),
      depthControls: byId('depth-controls'),
      rendererControls: byId('renderer-controls'),
      pointsControls: byId('points-controls'),
      pointsPerformanceControls: byId('points-performance-controls'),
      smokeControls: byId('smoke-controls'),

      pointSizeInput: byId('point-size'),
      pointSizeDisplay: byId('point-size-display'),
      lightingInput: byId('lighting-strength'),
      lightingDisplay: byId('lighting-strength-display'),
      fogInput: byId('fog-density'),
      fogDisplay: byId('fog-density-display'),
      sizeAttenuationInput: byId('size-attenuation'),
      sizeAttenuationDisplay: byId('size-attenuation-display'),

      hpShaderQualitySelect: byId('hp-shader-quality'),
      hpLodEnabledCheckbox: byId('hp-lod-enabled'),
      hpLodForceInput: byId('hp-lod-force'),
      hpLodForceContainer: byId('lod-force-container'),
      hpLodForceDisplay: byId('hp-lod-force-label'),
      hpFrustumCullingCheckbox: byId('hp-frustum-culling'),
      hpAntialiasCheckbox: byId('hp-antialias'),
      hpAntialiasStatus: byId('hp-antialias-status'),
      hpPerformanceStatus: byId('hp-performance-status'),

      smokeGridInput: byId('smoke-grid'),
      smokeGridDisplay: byId('smoke-grid-display'),
      smokeStepsInput: byId('smoke-steps'),
      smokeStepsDisplay: byId('smoke-steps-display'),
      smokeDensityInput: byId('smoke-density'),
      smokeDensityDisplay: byId('smoke-density-display'),
      smokeSpeedInput: byId('smoke-speed'),
      smokeSpeedDisplay: byId('smoke-speed-display'),
      smokeDetailInput: byId('smoke-detail'),
      smokeDetailDisplay: byId('smoke-detail-display'),
      smokeWarpInput: byId('smoke-warp'),
      smokeWarpDisplay: byId('smoke-warp-display'),
      smokeAbsorptionInput: byId('smoke-absorption'),
      smokeAbsorptionDisplay: byId('smoke-absorption-display'),
      smokeScatterInput: byId('smoke-scatter'),
      smokeScatterDisplay: byId('smoke-scatter-display'),
      smokeEdgeInput: byId('smoke-edge'),
      smokeEdgeDisplay: byId('smoke-edge-display'),
      smokeDirectLightInput: byId('smoke-direct-light'),
      smokeDirectLightDisplay: byId('smoke-direct-light-display'),
      cloudResolutionInput: byId('cloud-resolution'),
      cloudResolutionDisplay: byId('cloud-resolution-display'),
      noiseResolutionInput: byId('noise-resolution'),
      noiseResolutionDisplay: byId('noise-resolution-display'),

      velocityControls: byId('velocity-overlay-controls'),
      velocitySettings: byId('velocity-overlay-settings'),
      velocityInfo: byId('velocity-overlay-info'),
      velocityEnabledCheckbox: byId('velocity-overlay-enabled'),
      velocityFieldSelect: byId('velocity-field'),
      velocityDensityInput: byId('velocity-density'),
      velocityDensityDisplay: byId('velocity-density-display'),
      velocitySpeedInput: byId('velocity-speed'),
      velocitySpeedDisplay: byId('velocity-speed-display'),
      velocityLifetimeInput: byId('velocity-lifetime'),
      velocityLifetimeDisplay: byId('velocity-lifetime-display'),
      velocitySizeInput: byId('velocity-size'),
      velocitySizeDisplay: byId('velocity-size-display'),
      velocityOpacityInput: byId('velocity-opacity'),
      velocityOpacityDisplay: byId('velocity-opacity-display'),
      velocityColormapSelect: byId('velocity-colormap'),
      velocitySyncLodCheckbox: byId('velocity-sync-lod'),
      // Advanced visual settings - Particle Rendering
      velocityIntensityInput: byId('velocity-intensity'),
      velocityIntensityDisplay: byId('velocity-intensity-display'),
      velocityGlowInput: byId('velocity-glow'),
      velocityGlowDisplay: byId('velocity-glow-display'),
      velocityCometStretchInput: byId('velocity-comet-stretch'),
      velocityCometStretchDisplay: byId('velocity-comet-stretch-display'),
      velocityCoreSharpnessInput: byId('velocity-core-sharpness'),
      velocityCoreSharpnessDisplay: byId('velocity-core-sharpness-display'),
      // Advanced visual settings - Trail
      velocityTrailFadeInput: byId('velocity-trail-fade'),
      velocityTrailFadeDisplay: byId('velocity-trail-fade-display'),
      velocityChromaticFadeInput: byId('velocity-chromatic-fade'),
      velocityChromaticFadeDisplay: byId('velocity-chromatic-fade-display'),
      velocityTurbulenceInput: byId('velocity-turbulence'),
      velocityTurbulenceDisplay: byId('velocity-turbulence-display'),
      // Advanced visual settings - HDR & Bloom
      velocityExposureInput: byId('velocity-exposure'),
      velocityExposureDisplay: byId('velocity-exposure-display'),
      velocityBloomStrengthInput: byId('velocity-bloom-strength'),
      velocityBloomStrengthDisplay: byId('velocity-bloom-strength-display'),
      velocityBloomThresholdInput: byId('velocity-bloom-threshold'),
      velocityBloomThresholdDisplay: byId('velocity-bloom-threshold-display'),
      velocityAnamorphicInput: byId('velocity-anamorphic'),
      velocityAnamorphicDisplay: byId('velocity-anamorphic-display'),
      // Advanced visual settings - Color Grading
      velocitySaturationInput: byId('velocity-saturation'),
      velocitySaturationDisplay: byId('velocity-saturation-display'),
      velocityContrastInput: byId('velocity-contrast'),
      velocityContrastDisplay: byId('velocity-contrast-display'),
      velocityHighlightsInput: byId('velocity-highlights'),
      velocityHighlightsDisplay: byId('velocity-highlights-display'),
      velocityShadowsInput: byId('velocity-shadows'),
      velocityShadowsDisplay: byId('velocity-shadows-display'),
      // Advanced visual settings - Cinematic Effects
      velocityVignetteInput: byId('velocity-vignette'),
      velocityVignetteDisplay: byId('velocity-vignette-display'),
      velocityFilmGrainInput: byId('velocity-film-grain'),
      velocityFilmGrainDisplay: byId('velocity-film-grain-display'),
      velocityChromaticAberrationInput: byId('velocity-chromatic-aberration'),
      velocityChromaticAberrationDisplay: byId('velocity-chromatic-aberration-display'),
    },

    view: {
      controls: byId('split-view-controls'),
      keepViewBtn: byId('split-keep-view-btn'),
      clearBtn: byId('split-clear-btn'),
      cameraLockBtn: byId('camera-lock-btn'),
      layoutModeSelect: byId('view-layout-mode'),
      badgesBox: byId('split-view-badges-box'),
      badgesList: byId('split-view-badges-list'),
      layoutRow: byId('split-view-layout-row'),
      navigationTarget: byId('navigation-view-target'),
      navigationTargetBadge: byId('navigation-view-target-badge'),
    },

    representation: {
      controls: byId('representation-controls'),
      label: byId('view-representation-label'),
      select: byId('view-representation-select'),
    },

    dataMapping: {
      root: byId('data-mapping-root'),
    },

    figureExport: {
      section: byId('figure-export-section'),
      controls: byId('figure-export-controls'),
    },

    cellInfo: {
      toggle: byId('cell-info-toggle'),
      categoriesToggle: byId('cell-info-categories-toggle'),
      canvas: byId('glcanvas'),
    },

    camera: {
      resetBtn: byId('reset-camera-btn'),
      navigationModeSelect: byId('navigation-mode'),
      freeflyControls: byId('freefly-controls'),
      orbitControls: byId('orbit-controls'),
      planarControls: byId('planar-controls'),

      orbitKeySpeedInput: byId('orbit-key-speed'),
      orbitKeySpeedDisplay: byId('orbit-key-speed-display'),
      orbitReverseCheckbox: byId('orbit-reverse'),
      showOrbitAnchorCheckbox: byId('show-orbit-anchor'),

      planarPanSpeedInput: byId('planar-pan-speed'),
      planarPanSpeedDisplay: byId('planar-pan-speed-display'),
      planarZoomToCursorCheckbox: byId('planar-zoom-to-cursor'),
      planarInvertAxesCheckbox: byId('planar-invert-axes'),

      lookSensitivityInput: byId('look-sensitivity'),
      lookSensitivityDisplay: byId('look-sensitivity-display'),
      moveSpeedInput: byId('move-speed'),
      moveSpeedDisplay: byId('move-speed-display'),
      invertLookCheckbox: byId('invert-look'),
      projectilesEnabledCheckbox: byId('projectiles-enabled'),
      pointerLockCheckbox: byId('pointer-lock'),
    },

    cinematicCamera: {
      // Keyframe controls
      saveBtn: byId('cinematic-save-btn'),
      keyframeList: byId('cinematic-keyframe-list'),
      clearBtn: byId('cinematic-clear-btn'),
      timingActions: byId('cinematic-timing-actions'),
      setAllDuration: byId('cinematic-set-all-duration'),
      setAllBtn: byId('cinematic-set-all-btn'),

      // Settings
      defaultSpeedInput: byId('cinematic-default-speed'),
      defaultSpeedDisplay: byId('cinematic-default-speed-display'),
      positionInterp: byId('cinematic-position-interp'),
      rotationInterp: byId('cinematic-rotation-interp'),
      easingSelect: byId('cinematic-easing'),
      loopCheckbox: byId('cinematic-loop'),
      autoplayCheckbox: byId('cinematic-autoplay'),
      captionsCheckbox: byId('cinematic-captions'),
    },
  };
}
