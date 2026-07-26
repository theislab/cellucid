/**
 * @fileoverview Exact current contracts for figure-export requests and payloads.
 *
 * These validators never coerce, clamp, default, rename, or repair input.
 * Callers must publish a complete current-contract object before export starts.
 */

import { assertCameraState } from '../../../../rendering/camera-state-contract.js';
import { assertCropRect01 } from './utils/crop.js';

const FORMATS = new Set(['png', 'svg']);
const STRATEGIES = new Set(['full-vector', 'optimized-vector', 'hybrid']);
const LEGEND_POSITIONS = new Set(['right', 'bottom']);
const BACKGROUNDS = new Set(['viewer', 'white', 'transparent', 'custom']);
const SHADER_QUALITIES = new Set(['full', 'light', 'ultralight']);

const BASE_REQUEST_KEYS = Object.freeze([
  'axisLabelFontSizePx',
  'background',
  'backgroundColor',
  'centroidLabelFontSizePx',
  'crop',
  'depthSort3d',
  'emphasizeSelection',
  'exportAllViews',
  'fontFamily',
  'fontSizePx',
  'height',
  'includeAxes',
  'includeLegend',
  'legendFontSizePx',
  'legendPosition',
  'optimizedTargetCount',
  'selectionMutedOpacity',
  'showOrientation',
  'strategy',
  'tickFontSizePx',
  'title',
  'titleFontSizePx',
  'width',
  'xLabel',
  'yLabel',
]);
const SINGLE_REQUEST_KEYS = Object.freeze(
  [...BASE_REQUEST_KEYS, 'dpi', 'format'].sort()
);
const BATCH_REQUEST_KEYS = Object.freeze(
  [...BASE_REQUEST_KEYS, 'jobs'].sort()
);
const JOB_KEYS = Object.freeze(['dpi', 'format']);
const PAYLOAD_KEYS = Object.freeze([
  'dpi',
  'format',
  'height',
  'meta',
  'options',
  'title',
  'views',
  'width',
]);
const PAYLOAD_OPTION_KEYS = Object.freeze(
  BASE_REQUEST_KEYS.filter((key) => key !== 'exportAllViews').sort()
);
const VIEW_KEYS = Object.freeze([
  'cameraState',
  'data',
  'id',
  'label',
  'renderState',
]);
const VIEW_DATA_KEYS = Object.freeze([
  'centroidColors',
  'centroidFlags',
  'centroidLabelTexts',
  'centroidPositions',
  'colors',
  'pointCount',
  'positions',
  'transparency',
]);
const CENTROID_FLAG_KEYS = Object.freeze(['labels', 'points']);
const RENDER_STATE_KEYS = Object.freeze([
  'bgColor',
  'cameraDistance',
  'cameraPosition',
  'far',
  'fogColor',
  'fogDensity',
  'fov',
  'lightDir',
  'lightingStrength',
  'modelMatrix',
  'mvpMatrix',
  'near',
  'pointSize',
  'projectionMatrix',
  'shaderQuality',
  'sizeAttenuation',
  'viewMatrix',
  'viewportHeight',
  'viewportWidth',
]);

function assertPlainObject(value, context) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${context} must be a plain object.`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, context) {
  assertPlainObject(value, context);
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      `${context} must contain exactly: ${expectedKeys.join(', ')}.`
    );
  }
}

function assertString(value, context, { allowEmpty = true } = {}) {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw new TypeError(`${context} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
  }
}

function assertBoolean(value, context) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${context} must be an exact boolean.`);
  }
}

function assertInteger(value, context, minimum, maximum = Infinity) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${context} must be a safe integer from ${minimum} through ${maximum}.`
    );
  }
}

function assertFiniteNumber(value, context, minimum = -Infinity, maximum = Infinity) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${context} must be a finite number from ${minimum} through ${maximum}.`
    );
  }
}

function assertFormat(value, context) {
  if (!FORMATS.has(value)) {
    throw new TypeError(`${context} must be exactly "svg" or "png".`);
  }
}

function assertBaseRequest(request, expectedKeys, context) {
  assertExactKeys(request, expectedKeys, context);
  assertInteger(request.width, `${context}.width`, 10);
  assertInteger(request.height, `${context}.height`, 10);
  assertBoolean(request.exportAllViews, `${context}.exportAllViews`);
  assertString(request.title, `${context}.title`);
  assertBoolean(request.includeAxes, `${context}.includeAxes`);
  assertBoolean(request.includeLegend, `${context}.includeLegend`);
  if (!LEGEND_POSITIONS.has(request.legendPosition)) {
    throw new TypeError(`${context}.legendPosition must be "right" or "bottom".`);
  }
  assertString(request.xLabel, `${context}.xLabel`);
  assertString(request.yLabel, `${context}.yLabel`);
  if (!BACKGROUNDS.has(request.background)) {
    throw new TypeError(`${context}.background is not a current export background.`);
  }
  if (
    typeof request.backgroundColor !== 'string' ||
    !/^#[0-9a-fA-F]{6}$/.test(request.backgroundColor)
  ) {
    throw new TypeError(`${context}.backgroundColor must be an exact #RRGGBB color.`);
  }
  assertString(request.fontFamily, `${context}.fontFamily`, { allowEmpty: false });
  for (const key of [
    'fontSizePx',
    'legendFontSizePx',
    'tickFontSizePx',
    'axisLabelFontSizePx',
    'titleFontSizePx',
    'centroidLabelFontSizePx',
  ]) {
    assertInteger(request[key], `${context}.${key}`, 1);
  }
  assertCropRect01(request.crop);
  assertBoolean(request.showOrientation, `${context}.showOrientation`);
  assertBoolean(request.depthSort3d, `${context}.depthSort3d`);
  assertBoolean(request.emphasizeSelection, `${context}.emphasizeSelection`);
  assertFiniteNumber(
    request.selectionMutedOpacity,
    `${context}.selectionMutedOpacity`,
    0,
    1
  );
  return request;
}

function assertStrategyContract(request, requiresSvg, context) {
  if (!requiresSvg) {
    if (request.strategy !== null) {
      throw new TypeError(`${context}.strategy must be null for PNG-only export.`);
    }
    if (request.optimizedTargetCount !== null) {
      throw new TypeError(
        `${context}.optimizedTargetCount must be null for PNG-only export.`
      );
    }
    return;
  }

  if (!STRATEGIES.has(request.strategy)) {
    throw new TypeError(
      `${context}.strategy must be one explicit current SVG export strategy.`
    );
  }
  if (request.strategy === 'optimized-vector') {
    assertInteger(
      request.optimizedTargetCount,
      `${context}.optimizedTargetCount`,
      1000,
      5_000_000
    );
    return;
  }
  if (request.optimizedTargetCount !== null) {
    throw new TypeError(
      `${context}.optimizedTargetCount must be null unless strategy is "optimized-vector".`
    );
  }
}

function assertJob(job, context) {
  assertExactKeys(job, JOB_KEYS, context);
  assertFormat(job.format, `${context}.format`);
  if (job.format === 'png') {
    assertInteger(job.dpi, `${context}.dpi`, 72);
  } else if (job.dpi !== null) {
    throw new TypeError(`${context}.dpi must be null for SVG export.`);
  }
}

export function assertFigureExportSingleRequest(request) {
  assertBaseRequest(request, SINGLE_REQUEST_KEYS, 'Figure export request');
  assertFormat(request.format, 'Figure export request.format');
  if (request.format === 'png') {
    assertInteger(request.dpi, 'Figure export request.dpi', 72);
  } else if (request.dpi !== null) {
    throw new TypeError('Figure export request.dpi must be null for SVG export.');
  }
  assertStrategyContract(
    request,
    request.format === 'svg',
    'Figure export request'
  );
  return request;
}

export function assertFigureExportBatchRequest(request) {
  assertBaseRequest(request, BATCH_REQUEST_KEYS, 'Figure export batch request');
  if (!Array.isArray(request.jobs) || request.jobs.length === 0) {
    throw new TypeError('Figure export batch request.jobs must be a non-empty array.');
  }
  const seen = new Set();
  request.jobs.forEach((job, index) => {
    assertJob(job, `Figure export batch request.jobs[${index}]`);
    const key = job.format === 'png' ? `png:${job.dpi}` : 'svg';
    if (seen.has(key)) {
      throw new Error(`Duplicate figure export job "${key}".`);
    }
    seen.add(key);
  });
  assertStrategyContract(
    request,
    request.jobs.some((job) => job.format === 'svg'),
    'Figure export batch request'
  );
  return request;
}

export function assertFigureExportViewId(viewId, context = 'Figure export view id') {
  assertString(viewId, context, { allowEmpty: false });
  return viewId;
}

function assertFloat32Array(value, length, context, { checkValues = true } = {}) {
  if (!(value instanceof Float32Array) || value.length !== length) {
    throw new TypeError(`${context} must be a Float32Array of length ${length}.`);
  }
  if (checkValues) {
    for (const entry of value) {
      if (!Number.isFinite(entry)) {
        throw new TypeError(`${context} must contain only finite numbers.`);
      }
    }
  }
}

function assertUint8Array(value, length, context) {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${context} must be a Uint8Array of length ${length}.`);
  }
}

function assertRenderState(renderState, context) {
  assertExactKeys(renderState, RENDER_STATE_KEYS, context);
  for (const key of ['mvpMatrix', 'viewMatrix', 'modelMatrix', 'projectionMatrix']) {
    assertFloat32Array(renderState[key], 16, `${context}.${key}`);
  }
  for (const key of ['fogColor', 'bgColor', 'lightDir']) {
    assertFloat32Array(renderState[key], 3, `${context}.${key}`);
  }
  if (
    !Array.isArray(renderState.cameraPosition) ||
    renderState.cameraPosition.length !== 3
  ) {
    throw new TypeError(`${context}.cameraPosition must be a three-number array.`);
  }
  renderState.cameraPosition.forEach((value, index) => {
    assertFiniteNumber(value, `${context}.cameraPosition[${index}]`);
  });
  for (const key of [
    'pointSize',
    'sizeAttenuation',
    'fov',
    'near',
    'far',
    'lightingStrength',
    'fogDensity',
    'cameraDistance',
  ]) {
    assertFiniteNumber(renderState[key], `${context}.${key}`);
  }
  assertInteger(renderState.viewportWidth, `${context}.viewportWidth`, 1);
  assertInteger(renderState.viewportHeight, `${context}.viewportHeight`, 1);
  if (!SHADER_QUALITIES.has(renderState.shaderQuality)) {
    throw new TypeError(`${context}.shaderQuality is not a current shader quality.`);
  }
}

function assertViewData(data, context) {
  assertExactKeys(data, VIEW_DATA_KEYS, context);
  assertInteger(data.pointCount, `${context}.pointCount`, 0);
  assertFloat32Array(
    data.positions,
    data.pointCount * 3,
    `${context}.positions`,
    { checkValues: false }
  );
  assertUint8Array(data.colors, data.pointCount * 4, `${context}.colors`);
  assertFloat32Array(
    data.transparency,
    data.pointCount,
    `${context}.transparency`,
    { checkValues: false }
  );
  assertExactKeys(data.centroidFlags, CENTROID_FLAG_KEYS, `${context}.centroidFlags`);
  assertBoolean(data.centroidFlags.points, `${context}.centroidFlags.points`);
  assertBoolean(data.centroidFlags.labels, `${context}.centroidFlags.labels`);

  const centroidPresence = [
    data.centroidPositions,
    data.centroidColors,
  ].map((value) => value !== null);
  if (centroidPresence[0] !== centroidPresence[1]) {
    throw new TypeError(
      `${context} centroid positions and colors must both be present or both be null.`
    );
  }
  let centroidCount = 0;
  if (centroidPresence[0]) {
    if (
      !(data.centroidPositions instanceof Float32Array) ||
      data.centroidPositions.length % 3 !== 0
    ) {
      throw new TypeError(`${context}.centroidPositions must contain xyz triplets.`);
    }
    centroidCount = data.centroidPositions.length / 3;
    assertUint8Array(
      data.centroidColors,
      centroidCount * 4,
      `${context}.centroidColors`
    );
  }
  if (
    !Array.isArray(data.centroidLabelTexts) ||
    data.centroidLabelTexts.some((entry) => typeof entry !== 'string')
  ) {
    throw new TypeError(`${context}.centroidLabelTexts must be an array of strings.`);
  }
  if (
    data.centroidFlags.labels &&
    data.centroidLabelTexts.length !== centroidCount
  ) {
    throw new Error(
      `${context}.centroidLabelTexts must match the published centroid count when labels are enabled.`
    );
  }
}

function assertPayloadOptions(options, context) {
  const requestShape = { ...options, exportAllViews: false };
  assertBaseRequest(
    requestShape,
    BASE_REQUEST_KEYS,
    context
  );
  assertExactKeys(options, PAYLOAD_OPTION_KEYS, context);
}

export function assertFigureExportPayload(payload) {
  assertExactKeys(payload, PAYLOAD_KEYS, 'Figure export payload');
  assertFormat(payload.format, 'Figure export payload.format');
  assertInteger(payload.width, 'Figure export payload.width', 10);
  assertInteger(payload.height, 'Figure export payload.height', 10);
  if (payload.format === 'png') {
    assertInteger(payload.dpi, 'Figure export payload.dpi', 72);
  } else if (payload.dpi !== null) {
    throw new TypeError('Figure export payload.dpi must be null for SVG export.');
  }
  assertString(payload.title, 'Figure export payload.title');
  assertPayloadOptions(payload.options, 'Figure export payload.options');
  assertStrategyContract(
    payload.options,
    payload.format === 'svg',
    'Figure export payload.options'
  );
  assertPlainObject(payload.meta, 'Figure export payload.meta');
  if (!Array.isArray(payload.views) || payload.views.length === 0) {
    throw new TypeError('Figure export payload.views must be a non-empty array.');
  }
  const viewIds = new Set();
  payload.views.forEach((view, index) => {
    const context = `Figure export payload.views[${index}]`;
    assertExactKeys(view, VIEW_KEYS, context);
    assertFigureExportViewId(view.id, `${context}.id`);
    assertString(view.label, `${context}.label`, { allowEmpty: false });
    if (viewIds.has(view.id)) {
      throw new Error(`Figure export payload contains duplicate view "${view.id}".`);
    }
    viewIds.add(view.id);
    assertViewData(view.data, `${context}.data`);
    assertRenderState(view.renderState, `${context}.renderState`);
    assertCameraState(view.cameraState, `${context}.cameraState`);
  });
  return payload;
}

export function createFigureExportPayloadOptions(request, format) {
  assertFormat(format, 'Figure export payload format');
  const options = {};
  for (const key of PAYLOAD_OPTION_KEYS) {
    options[key] = request[key];
  }
  if (format === 'png') {
    options.strategy = null;
    options.optimizedTargetCount = null;
  }
  return Object.freeze(options);
}
