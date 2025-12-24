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
    sidebar: {
      el: byId('sidebar'),
      toggleBtn: byId('sidebar-toggle'),
      resizeHandle: byId('sidebar-resize-handle'),
    },

    stats: {
      el: byId('stats'),
    },

    dataset: {
      select: byId('dataset-select'),
      info: byId('dataset-info'),
      nameEl: byId('dataset-name'),
      sourceEl: byId('dataset-source'),
      descriptionEl: byId('dataset-description'),
      urlEl: byId('dataset-url'),
      cellsEl: byId('dataset-cells'),
      genesEl: byId('dataset-genes'),
      obsEl: byId('dataset-obs'),
      connectivityEl: byId('dataset-connectivity'),

      userDataBlock: byId('user-data-block'),
      userDataH5adBtn: byId('user-data-h5ad-btn'),
      userDataZarrBtn: byId('user-data-zarr-btn'),
      userDataBrowseBtn: byId('user-data-browse-btn'),
      userDataFileInput: byId('user-data-file-input'),
      userDataH5adInput: byId('user-data-h5ad-input'),
      userDataZarrInput: byId('user-data-zarr-input'),
      userDataInfoBtn: byId('user-data-info-btn'),
      userDataInfoTooltip: byId('user-data-info-tooltip'),

      remoteServerUrl: byId('remote-server-url'),
      remoteConnectBtn: byId('remote-connect-btn'),
      remoteDisconnectBtn: byId('remote-disconnect-btn'),
      remoteDisconnectContainer: byId('remote-disconnect-container'),
      remoteInfoBtn: byId('remote-info-btn'),
      remoteInfoTooltip: byId('remote-info-tooltip'),

      githubRepoUrl: byId('github-repo-url'),
      githubConnectBtn: byId('github-connect-btn'),
      githubDisconnectBtn: byId('github-disconnect-btn'),
      githubDisconnectContainer: byId('github-disconnect-container'),
      githubInfoBtn: byId('github-info-btn'),
      githubInfoTooltip: byId('github-info-tooltip'),
    },

    session: {
      saveBtn: byId('save-state-btn'),
      loadBtn: byId('load-state-btn'),
    },

    fieldSelector: {
      categoricalSelect: byId('categorical-field'),
      categoricalCopyBtn: byId('copy-categorical-field'),
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

      centroidControls: byId('centroid-controls'),
      centroidPointsCheckbox: byId('toggle-centroid-points'),
      centroidLabelsCheckbox: byId('toggle-centroid-labels'),
    },

    filter: {
      countEl: byId('filter-count'),
      activeFiltersEl: byId('active-filters'),
    },

    highlight: {
      countEl: byId('highlight-count'),
      groupsEl: byId('highlighted-groups-list'),
      pagesTabsEl: byId('highlight-pages-tabs'),
      addPageBtn: byId('add-highlight-page'),
      clearAllBtn: byId('clear-all-highlights'),
      modeButtons: $$('.highlight-mode-btn'),
      modeDescription: byId('highlight-mode-description'),
    },

    communityAnnotation: {
      section: byId('community-annotation-section'),
      container: byId('community-annotation-controls'),
    },

    render: {
      backgroundSelect: byId('background-select'),
      renderModeSelect: byId('render-mode'),
      depthControls: byId('depth-controls'),
      rendererControls: byId('renderer-controls'),
      pointsControls: byId('points-controls'),
      smokeControls: byId('smoke-controls'),

      pointSizeInput: byId('point-size'),
      pointSizeDisplay: byId('point-size-display'),
      lightingInput: byId('lighting-strength'),
      lightingDisplay: byId('lighting-strength-display'),
      fogInput: byId('fog-density'),
      fogDisplay: byId('fog-density-display'),
      sizeAttenuationInput: byId('size-attenuation'),
      sizeAttenuationDisplay: byId('size-attenuation-display'),

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
      badgesHint: $('.split-view-hint'),
      boxTitle: $('.split-view-box-title'),
    },

    dimension: {
      controls: byId('dimension-controls'),
      select: byId('dimension-select'),
    },

    figureExport: {
      section: byId('figure-export-section'),
      controls: byId('figure-export-controls'),
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
  };
}
