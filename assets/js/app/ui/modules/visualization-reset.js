/**
 * @fileoverview Reset-to-defaults wiring for visualization + camera controls.
 *
 * Captures the initial UI control values after initialization, then restores
 * them when the user clicks "Reset Camera" (or presses `R` outside inputs).
 *
 * This module bridges render + camera controls, so it intentionally takes both
 * dom groups and the relevant module helpers.
 *
 * @module ui/modules/visualization-reset
 */

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {object} options.renderDom
 * @param {object} options.cameraDom
 * @param {object} options.renderControls
 * @param {object} options.cameraControls
 */
export function initVisualizationReset({ viewer, renderDom, cameraDom, renderControls, cameraControls }) {
  const resetCameraBtn = cameraDom?.resetBtn || null;

  const backgroundSelect = renderDom?.backgroundSelect || null;
  const renderModeSelect = renderDom?.renderModeSelect || null;
  const pointSizeInput = renderDom?.pointSizeInput || null;
  const lightingStrengthInput = renderDom?.lightingInput || null;
  const lightingStrengthDisplay = renderDom?.lightingDisplay || null;
  const fogDensityInput = renderDom?.fogInput || null;
  const fogDensityDisplay = renderDom?.fogDisplay || null;
  const sizeAttenuationInput = renderDom?.sizeAttenuationInput || null;
  const sizeAttenuationDisplay = renderDom?.sizeAttenuationDisplay || null;

  const smokeStepsInput = renderDom?.smokeStepsInput || null;
  const smokeDensityInput = renderDom?.smokeDensityInput || null;
  const smokeSpeedInput = renderDom?.smokeSpeedInput || null;
  const smokeDetailInput = renderDom?.smokeDetailInput || null;
  const smokeWarpInput = renderDom?.smokeWarpInput || null;
  const smokeAbsorptionInput = renderDom?.smokeAbsorptionInput || null;
  const smokeScatterInput = renderDom?.smokeScatterInput || null;
  const smokeEdgeInput = renderDom?.smokeEdgeInput || null;
  const smokeDirectLightInput = renderDom?.smokeDirectLightInput || null;
  const smokeGridInput = renderDom?.smokeGridInput || null;
  const cloudResolutionInput = renderDom?.cloudResolutionInput || null;
  const noiseResolutionInput = renderDom?.noiseResolutionInput || null;

  const navigationModeSelect = cameraDom?.navigationModeSelect || null;
  const lookSensitivityInput = cameraDom?.lookSensitivityInput || null;
  const moveSpeedInput = cameraDom?.moveSpeedInput || null;
  const invertLookCheckbox = cameraDom?.invertLookCheckbox || null;
  const orbitReverseCheckbox = cameraDom?.orbitReverseCheckbox || null;
  const planarZoomToCursorCheckbox = cameraDom?.planarZoomToCursorCheckbox || null;
  const planarInvertAxesCheckbox = cameraDom?.planarInvertAxesCheckbox || null;
  const showOrbitAnchorCheckbox = cameraDom?.showOrbitAnchorCheckbox || null;

  let initialUIState = null;

  function captureInitialState() {
    initialUIState = {
      background: backgroundSelect?.value || 'white',
      renderMode: renderModeSelect?.value || 'points',
      pointSize: pointSizeInput?.value || String(renderControls.pointSizeToSlider?.(0.75) ?? 0),
      lighting: lightingStrengthInput?.value || '60',
      fog: fogDensityInput?.value || '50',
      sizeAttenuation: sizeAttenuationInput?.value || '80',

      smokeGrid: smokeGridInput?.value || '60',
      smokeSteps: smokeStepsInput?.value || '75',
      smokeDensity: smokeDensityInput?.value || '56',
      smokeSpeed: smokeSpeedInput?.value || '40',
      smokeDetail: smokeDetailInput?.value || '60',
      smokeWarp: smokeWarpInput?.value || '10',
      smokeAbsorption: smokeAbsorptionInput?.value || '65',
      smokeScatter: smokeScatterInput?.value || '0',
      smokeEdge: smokeEdgeInput?.value || '0',
      smokeDirectLight: smokeDirectLightInput?.value || '3',
      cloudResolution: cloudResolutionInput?.value || '15',
      noiseResolution: noiseResolutionInput?.value || '58',

      navigationMode: navigationModeSelect?.value || 'orbit',
      lookSensitivity: lookSensitivityInput?.value || '5',
      moveSpeed: moveSpeedInput?.value || '100',
      invertLook: invertLookCheckbox?.checked || false,
      orbitInvertRotation: orbitReverseCheckbox?.checked || false,
      showOrbitAnchor: showOrbitAnchorCheckbox?.checked ?? true,
      planarZoomToCursor: planarZoomToCursorCheckbox?.checked ?? true,
      planarInvertAxes: planarInvertAxesCheckbox?.checked || false
    };
  }

  function resetVisualizationToDefaults() {
    if (!initialUIState) return;

    viewer.resetCamera?.();
    const defaultRenderMode = initialUIState.renderMode || 'points';
    const navMode = initialUIState.navigationMode || 'orbit';

    if (backgroundSelect) {
      backgroundSelect.value = initialUIState.background;
      viewer.setBackground?.(initialUIState.background);
    }

    if (renderModeSelect) {
      renderModeSelect.value = defaultRenderMode;
    }
    renderControls.applyRenderMode?.(defaultRenderMode);

    if (navigationModeSelect) {
      navigationModeSelect.value = navMode;
      viewer.setNavigationMode?.(navMode);
      cameraControls.toggleNavigationPanels?.(navMode);
    }

    if (lookSensitivityInput) {
      lookSensitivityInput.value = initialUIState.lookSensitivity || '5';
      cameraControls.updateLookSensitivity?.();
    }

    if (moveSpeedInput) {
      moveSpeedInput.value = initialUIState.moveSpeed || '100';
      cameraControls.updateMoveSpeed?.();
    }

    if (invertLookCheckbox && viewer.setInvertLook) {
      invertLookCheckbox.checked = Boolean(initialUIState.invertLook);
      viewer.setInvertLook(Boolean(invertLookCheckbox.checked));
    }

    if (orbitReverseCheckbox && viewer.setOrbitInvertRotation) {
      orbitReverseCheckbox.checked = Boolean(initialUIState.orbitInvertRotation);
      viewer.setOrbitInvertRotation(Boolean(orbitReverseCheckbox.checked));
    }

    if (planarZoomToCursorCheckbox && viewer.setPlanarZoomToCursor) {
      planarZoomToCursorCheckbox.checked = Boolean(initialUIState.planarZoomToCursor);
      viewer.setPlanarZoomToCursor(Boolean(planarZoomToCursorCheckbox.checked));
    }

    if (planarInvertAxesCheckbox && viewer.setPlanarInvertAxes) {
      planarInvertAxesCheckbox.checked = Boolean(initialUIState.planarInvertAxes);
      viewer.setPlanarInvertAxes(Boolean(planarInvertAxesCheckbox.checked));
    }

    if (showOrbitAnchorCheckbox && viewer.setShowOrbitAnchor) {
      showOrbitAnchorCheckbox.checked = initialUIState.showOrbitAnchor ?? true;
      viewer.setShowOrbitAnchor(Boolean(showOrbitAnchorCheckbox.checked));
    }

    if (pointSizeInput) {
      pointSizeInput.value = initialUIState.pointSize;
      renderControls.applyPointSizeFromSlider?.();
    }

    if (lightingStrengthInput) {
      lightingStrengthInput.value = initialUIState.lighting;
      const v = parseFloat(initialUIState.lighting);
      viewer.setLightingStrength?.(Number.isFinite(v) ? v / 100.0 : 0.6);
      if (lightingStrengthDisplay) lightingStrengthDisplay.textContent = lightingStrengthInput.value;
    }

    if (fogDensityInput) {
      fogDensityInput.value = initialUIState.fog;
      const v = parseFloat(initialUIState.fog);
      viewer.setFogDensity?.(Number.isFinite(v) ? v / 100.0 : 0.5);
      if (fogDensityDisplay) fogDensityDisplay.textContent = fogDensityInput.value;
    }

    if (sizeAttenuationInput) {
      sizeAttenuationInput.value = initialUIState.sizeAttenuation;
      const v = parseFloat(initialUIState.sizeAttenuation);
      viewer.setSizeAttenuation?.(Number.isFinite(v) ? v / 100.0 : 0);
      if (sizeAttenuationDisplay) sizeAttenuationDisplay.textContent = sizeAttenuationInput.value;
    }

    if (smokeStepsInput) {
      smokeStepsInput.value = initialUIState.smokeSteps;
      renderControls.updateSmokeStepSlider?.();
    }
    if (smokeDensityInput) {
      smokeDensityInput.value = initialUIState.smokeDensity;
      renderControls.updateSmokeDensitySlider?.();
    }
    if (smokeSpeedInput) {
      smokeSpeedInput.value = initialUIState.smokeSpeed;
      renderControls.updateSmokeSpeedSlider?.();
    }
    if (smokeDetailInput) {
      smokeDetailInput.value = initialUIState.smokeDetail;
      renderControls.updateSmokeDetailSlider?.();
    }
    if (smokeWarpInput) {
      smokeWarpInput.value = initialUIState.smokeWarp;
      renderControls.updateSmokeWarpSlider?.();
    }
    if (smokeAbsorptionInput) {
      smokeAbsorptionInput.value = initialUIState.smokeAbsorption;
      renderControls.updateSmokeAbsorptionSlider?.();
    }
    if (smokeScatterInput) {
      smokeScatterInput.value = initialUIState.smokeScatter;
      renderControls.updateSmokeScatterSlider?.();
    }
    if (smokeEdgeInput) {
      smokeEdgeInput.value = initialUIState.smokeEdge;
      renderControls.updateSmokeEdgeSlider?.();
    }
    if (smokeDirectLightInput && initialUIState.smokeDirectLight != null) {
      smokeDirectLightInput.value = initialUIState.smokeDirectLight;
      renderControls.updateSmokeDirectLightSlider?.();
    }
    if (smokeGridInput) {
      smokeGridInput.value = initialUIState.smokeGrid;
      renderControls.updateSmokeGridSlider?.();
    }

    if (cloudResolutionInput && viewer.setCloudResolutionScale) {
      const cloudResVal = initialUIState.cloudResolution ?? 25;
      cloudResolutionInput.value = cloudResVal;
      renderControls.updateCloudResolutionSlider?.();
    }

    if (noiseResolutionInput && viewer.setNoiseTextureResolution) {
      const noiseResVal = initialUIState.noiseResolution ?? 64;
      noiseResolutionInput.value = noiseResVal;
      renderControls.updateNoiseResolutionSlider?.();
    }

    renderControls.rebuildSmokeDensity?.();
    renderControls.markSmokeClean?.();
  }

  if (resetCameraBtn) {
    resetCameraBtn.addEventListener('click', () => {
      resetVisualizationToDefaults();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
    if (e.key === 'r' || e.key === 'R') {
      viewer.resetCamera?.();
    }
  });

  captureInitialState();

  return { resetVisualizationToDefaults, captureInitialState };
}
