/**
 * @fileoverview The navigation settings of the Navigation panel: one settings
 * box per mode, four speed sliders and five option checkboxes, with the slider
 * conversions and readout formats. camera-controls.js adds the mode select,
 * pointer capture and projectiles.
 *
 * @module ui/modules/navigation-settings
 */

import { parseRangeInput } from '../core/numeric-input-contract.js';
import { formatMultiplier, formatWithUnit } from '../components/display-format.js';

/** Slider position → viewer value and readout, for each speed slider. */
const SLIDERS = Object.freeze({
  orbitKeySpeed: {
    minimum: 1,
    maximum: 100,
    label: 'orbit keyboard speed',
    read(raw) {
      const value = raw / 100;
      return { value, text: formatMultiplier(value, 2) };
    }
  },
  planarPanSpeed: {
    minimum: 1,
    maximum: 100,
    label: 'planar keyboard pan speed',
    read(raw) {
      const t = (raw - 1) / 99;
      const value = 0.001 + t * (0.0075 - 0.001);
      return { value, text: formatMultiplier(value, 4) };
    }
  },
  lookSensitivity: {
    minimum: 1,
    maximum: 30,
    label: 'look sensitivity',
    read(raw) {
      // Radians per pixel; the readout keeps the slider's relative scale.
      return { value: raw * 0.0005, text: formatMultiplier(raw / 100, 2) };
    }
  },
  moveSpeed: {
    minimum: 1,
    maximum: 500,
    label: 'move speed',
    read(raw) {
      const value = raw / 100; // scene units per second
      return { value, text: formatWithUnit(value, 2, 'u/s') };
    }
  }
});

const REQUIRED_DOM_KEYS = Object.freeze([
  'orbitControls',
  'planarControls',
  'freeflyControls',
  'orbitKeySpeedInput',
  'orbitKeySpeedDisplay',
  'planarPanSpeedInput',
  'planarPanSpeedDisplay',
  'lookSensitivityInput',
  'lookSensitivityDisplay',
  'moveSpeedInput',
  'moveSpeedDisplay',
  'orbitReverseCheckbox',
  'showOrbitAnchorCheckbox',
  'planarZoomToCursorCheckbox',
  'planarInvertAxesCheckbox',
  'invertLookCheckbox'
]);

/**
 * Read one navigation slider: its viewer value and its readout text.
 *
 * @param {'orbitKeySpeed'|'planarPanSpeed'|'lookSensitivity'|'moveSpeed'} kind
 * @param {string} rawValue - The range input's exact value string.
 * @param {string} owner - Panel name used in validation messages.
 * @returns {{ value: number, text: string }}
 */
export function readNavigationSlider(kind, rawValue, owner) {
  const slider = SLIDERS[kind];
  if (!slider) throw new TypeError(`Unknown navigation slider "${kind}"`);
  const raw = parseRangeInput(rawValue, {
    minimum: slider.minimum,
    maximum: slider.maximum,
    label: `${owner} ${slider.label}`
  });
  return slider.read(raw);
}

/**
 * Wire one panel's navigation settings to the viewer.
 *
 * @param {object} options
 * @param {object} options.viewer
 * @param {Record<string, HTMLElement>} options.dom - The panel's controls.
 * @param {(target: EventTarget, type: string, listener: Function) => void} options.listen -
 *   The panel's lifecycle-owned listener registration.
 * @param {() => boolean} options.isDestroyed
 * @param {string} options.owner - Panel name used in validation messages.
 */
export function wireNavigationSettings({ viewer, dom, listen, isDestroyed, owner }) {
  for (const key of REQUIRED_DOM_KEYS) {
    if (!dom[key]) throw new Error(`${owner} navigation settings are missing "${key}".`);
  }

  /** Show the settings box of `mode` and hide the other two. */
  function showPanels(mode) {
    if (isDestroyed()) return;
    dom.orbitControls.hidden = mode !== 'orbit';
    dom.planarControls.hidden = mode !== 'planar';
    dom.freeflyControls.hidden = mode !== 'free';
  }

  const sliderUpdater = (kind, input, display, apply) => () => {
    if (isDestroyed()) return;
    const { value, text } = readNavigationSlider(kind, input.value, owner);
    display.textContent = text;
    apply(value);
  };

  const updateOrbitKeySpeed = sliderUpdater(
    'orbitKeySpeed', dom.orbitKeySpeedInput, dom.orbitKeySpeedDisplay,
    value => viewer.setOrbitKeySpeed(value)
  );
  const updatePlanarPanSpeed = sliderUpdater(
    'planarPanSpeed', dom.planarPanSpeedInput, dom.planarPanSpeedDisplay,
    value => viewer.setPlanarPanSpeed(value)
  );
  const updateLookSensitivity = sliderUpdater(
    'lookSensitivity', dom.lookSensitivityInput, dom.lookSensitivityDisplay,
    value => viewer.setLookSensitivity(value)
  );
  const updateMoveSpeed = sliderUpdater(
    'moveSpeed', dom.moveSpeedInput, dom.moveSpeedDisplay,
    value => viewer.setMoveSpeed(value)
  );

  // The viewer setters are cheap uniform writes, so each `input` applies at
  // once and the readout follows the thumb.
  for (const [update, input] of [
    [updateOrbitKeySpeed, dom.orbitKeySpeedInput],
    [updatePlanarPanSpeed, dom.planarPanSpeedInput],
    [updateLookSensitivity, dom.lookSensitivityInput],
    [updateMoveSpeed, dom.moveSpeedInput]
  ]) {
    update();
    listen(input, 'input', update);
  }

  const applyInvertLook = value => {
    if (isDestroyed()) return;
    viewer.setInvertLookY(value);
    viewer.setInvertLookX(value);
  };

  for (const [checkbox, apply] of [
    [dom.orbitReverseCheckbox, value => viewer.setOrbitInvertRotation(value)],
    [dom.showOrbitAnchorCheckbox, value => viewer.setShowOrbitAnchor(value)],
    [dom.planarZoomToCursorCheckbox, value => viewer.setPlanarZoomToCursor(value)],
    [dom.planarInvertAxesCheckbox, value => viewer.setPlanarInvertAxes(value)],
    [dom.invertLookCheckbox, applyInvertLook]
  ]) {
    apply(checkbox.checked);
    listen(checkbox, 'change', () => {
      apply(checkbox.checked);
      // Hand the keyboard back to the plot, so WASD moves at once.
      checkbox.blur();
    });
  }

  return {
    showPanels,
    applyInvertLook,
    updateOrbitKeySpeed,
    updatePlanarPanSpeed,
    updateLookSensitivity,
    updateMoveSpeed
  };
}
