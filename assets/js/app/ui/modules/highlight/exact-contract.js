import {
  CellSet,
  cellListsEqual,
  requireCellList
} from '../../../utils/cell-set.js';
import {
  ABANDONED_GESTURE_REASONS,
  ANNOTATION_ABANDONED_GESTURE_REASONS
} from './mode-copy.js';
import { isObjectRecord, requireExactKeys, requirePlainRecord } from '../../../../utils/exact-record.js';
import { formatCountOf } from '../../../../utils/format-units.js';

const SELECTION_MODES = Object.freeze([
  'annotation',
  'knn',
  'proximity',
  'lasso'
]);
const SELECTION_MODE_SET = new Set(SELECTION_MODES);
const COMBINE_MODES = new Set(['intersect', 'union', 'subtract']);
const HIGHLIGHT_SELECTION_STATE_KEYS = Object.freeze([
  'activeMode',
  'annotationCandidateSet',
  'annotationStepCount',
  'annotationHistory',
  'annotationRedoStack',
  'lassoHistory',
  'lassoRedoStack',
  'lastLassoCandidates',
  'lastLassoStep',
  'proximityHistory',
  'proximityRedoStack',
  'lastProximityCandidates',
  'lastProximityStep',
  'knnHistory',
  'knnRedoStack',
  'lastKnnCandidates',
  'lastKnnStep'
]);
const DIRECT_HIGHLIGHT_GROUP_TYPES = new Set([
  'annotation',
  'combined',
  'knn',
  'lasso',
  'proximity'
]);
const DIRECT_HIGHLIGHT_GROUP_KEYS = Object.freeze([
  'id',
  'type',
  'label',
  'enabled',
  'cellIndices',
  'cellCount'
]);
const FIELD_HIGHLIGHT_GROUP_KEYS = Object.freeze([
  ...DIRECT_HIGHLIGHT_GROUP_KEYS,
  'fieldKey',
  'fieldIndex',
  'fieldSource'
]);

export function requireMethods(owner, label, methodNames) {
  if (!isObjectRecord(owner)) {
    throw new TypeError(`${label} must be an object.`);
  }
  for (const methodName of methodNames) {
    if (typeof owner[methodName] !== 'function') {
      throw new TypeError(`${label} must expose ${methodName}().`);
    }
  }
  return owner;
}

export function requireDomElement(element, label, methods = []) {
  if (!isObjectRecord(element)) {
    throw new TypeError(`${label} must be a DOM element.`);
  }
  requireMethods(element, label, methods);
  return element;
}

export function requireCallback(callback, label) {
  if (typeof callback !== 'function') {
    throw new TypeError(`${label} must be a function.`);
  }
  return callback;
}

export function requireHighlightSelectionMode(mode) {
  if (!SELECTION_MODE_SET.has(mode)) {
    throw new TypeError(`Unknown highlight selection mode: ${mode}.`);
  }
  return mode;
}

export function requireCombineMode(mode, label) {
  if (!COMBINE_MODES.has(mode)) {
    throw new TypeError(
      `${label} mode must be exactly "intersect", "union", or "subtract".`
    );
  }
  return mode;
}

export function requireFieldSource(source) {
  if (source !== 'obs' && source !== 'var') {
    throw new TypeError(
      'Highlight field source must be exactly "obs" or "var".'
    );
  }
  return source;
}

export function requireSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer of at least ${minimum}.`);
  }
  return value;
}

export function requireFiniteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite.`);
  }
  return value;
}

export function requirePointCount(value, label) {
  return requireSafeInteger(value, `${label} point count`, 0);
}

export function requireCellIndex(value, label, pointCount) {
  requireSafeInteger(value, label, 0);
  requirePointCount(pointCount, label);
  if (value >= pointCount) {
    throw new RangeError(
      `${label} must be inside the current dataset of ${formatCountOf(pointCount, 'cell')}.`
    );
  }
  return value;
}

/**
 * Require a selection's cells as the one currency selections cross module
 * boundaries in: a cell list (`requireCellList`), checked in one pass.
 */
export function requireCellIndices(value, label, { allowEmpty, pointCount }) {
  requirePointCount(pointCount, label);
  requireCellList(value, pointCount, label);
  if (!allowEmpty && value.length === 0) {
    throw new TypeError(`${label} must not be empty.`);
  }
  return value;
}

function requireCandidateCollection(value, label, collectionType, pointCount) {
  if (value === null) return null;
  if (collectionType === 'set') {
    // A CellSet holds unique in-range cells by construction.
    if (!(value instanceof CellSet) || value.cellCount !== pointCount) {
      throw new TypeError(`${label} must be a CellSet over the current dataset or null.`);
    }
    return value;
  }
  requireCellIndices(value, label, { allowEmpty: true, pointCount });
  return value;
}

function requireCandidateState(
  candidates,
  step,
  label,
  collectionType,
  pointCount
) {
  requireCandidateCollection(
    candidates,
    `${label} candidates`,
    collectionType,
    pointCount
  );
  requireSafeInteger(step, `${label} step`, 0);
  if (candidates === null && step !== 0) {
    throw new TypeError(`${label} without candidates must have step zero.`);
  }
  if (candidates !== null && step === 0) {
    throw new TypeError(`${label} with candidates requires a positive step.`);
  }
}

function requireSelectionHistory(history, label, collectionType, pointCount) {
  if (!Array.isArray(history)) {
    throw new TypeError(`${label} must be an array.`);
  }
  for (let index = 0; index < history.length; index++) {
    if (!Object.hasOwn(history, index)) {
      throw new TypeError(`${label} must not contain holes.`);
    }
    const entry = history[index];
    requireExactKeys(
      entry,
      ['candidates', 'step'],
      `${label} entry`
    );
    requireCandidateState(
      entry.candidates,
      entry.step,
      `${label} entry`,
      collectionType,
      pointCount
    );
  }
  return history;
}

export function requireHighlightSelectionState(value, pointCount) {
  requireExactKeys(
    value,
    HIGHLIGHT_SELECTION_STATE_KEYS,
    'Highlight selection state'
  );
  requirePointCount(pointCount, 'Highlight selection state');
  requireHighlightSelectionMode(value.activeMode);
  requireCandidateState(
    value.annotationCandidateSet,
    value.annotationStepCount,
    'Annotation selection state',
    'set',
    pointCount
  );
  requireSelectionHistory(
    value.annotationHistory,
    'Annotation selection history',
    'set',
    pointCount
  );
  requireSelectionHistory(
    value.annotationRedoStack,
    'Annotation selection redo stack',
    'set',
    pointCount
  );
  for (const tool of ['Lasso', 'Proximity', 'Knn']) {
    const propertyPrefix = tool === 'Knn' ? 'Knn' : tool;
    const lower = tool.toLowerCase();
    requireCandidateState(
      value[`last${propertyPrefix}Candidates`],
      value[`last${propertyPrefix}Step`],
      `${tool.toUpperCase()} selection state`,
      'array',
      pointCount
    );
    requireSelectionHistory(
      value[`${lower}History`],
      `${tool.toUpperCase()} selection history`,
      'array',
      pointCount
    );
    requireSelectionHistory(
      value[`${lower}RedoStack`],
      `${tool.toUpperCase()} selection redo stack`,
      'array',
      pointCount
    );
  }
  return value;
}

export function requireHighlightGroup(value, label, pointCount) {
  requirePlainRecord(value, label);
  requirePointCount(pointCount, label);
  const { type } = value;
  let keys;
  if (DIRECT_HIGHLIGHT_GROUP_TYPES.has(type)) {
    keys = DIRECT_HIGHLIGHT_GROUP_KEYS;
  } else if (type === 'category') {
    keys = [
      ...FIELD_HIGHLIGHT_GROUP_KEYS,
      'categoryIndex',
      'categoryName'
    ];
  } else if (type === 'range') {
    keys = [
      ...FIELD_HIGHLIGHT_GROUP_KEYS,
      'rangeMin',
      'rangeMax'
    ];
  } else {
    throw new TypeError(`${label} type is unsupported.`);
  }
  requireExactKeys(value, keys, label);
  if (
    typeof value.id !== 'string'
    || !/^highlight_[1-9]\d*$/.test(value.id)
  ) {
    throw new TypeError(
      `${label} id must use the current "highlight_<positive integer>" identity.`
    );
  }
  if (
    typeof value.label !== 'string'
    || value.label.length === 0
    || value.label !== value.label.trim()
  ) {
    throw new TypeError(`${label} label must be a nonempty trimmed string.`);
  }
  if (typeof value.enabled !== 'boolean') {
    throw new TypeError(`${label} enabled must be boolean.`);
  }
  requireSafeInteger(value.cellCount, `${label} cellCount`, 1);
  requireCellList(value.cellIndices, pointCount, `${label} cellIndices`);
  if (value.cellIndices.length !== value.cellCount) {
    throw new TypeError(`${label} cellIndices must match cellCount.`);
  }
  if (type === 'category' || type === 'range') {
    if (
      typeof value.fieldKey !== 'string'
      || value.fieldKey.length === 0
      || value.fieldKey !== value.fieldKey.trim()
    ) {
      throw new TypeError(
        `${label} fieldKey must be a nonempty trimmed string.`
      );
    }
    requireSafeInteger(value.fieldIndex, `${label} fieldIndex`, 0);
    requireFieldSource(value.fieldSource);
  }
  if (type === 'category') {
    requireSafeInteger(value.categoryIndex, `${label} categoryIndex`, 0);
    if (
      typeof value.categoryName !== 'string'
      && typeof value.categoryName !== 'boolean'
      && !(
        typeof value.categoryName === 'number'
        && Number.isFinite(value.categoryName)
      )
    ) {
      throw new TypeError(
        `${label} categoryName must be a string, boolean, or finite number.`
      );
    }
  }
  if (type === 'range') {
    requireFiniteNumber(value.rangeMin, `${label} rangeMin`);
    requireFiniteNumber(value.rangeMax, `${label} rangeMax`);
    if (value.rangeMin > value.rangeMax) {
      throw new RangeError(`${label} rangeMin must not exceed rangeMax.`);
    }
  }
  return value;
}

export function requireSavedHighlightGroup(
  value,
  expectedType,
  expectedCellIndices,
  label,
  pointCount
) {
  requireHighlightGroup(value, label, pointCount);
  if (!DIRECT_HIGHLIGHT_GROUP_TYPES.has(expectedType)) {
    throw new TypeError(
      `Saved highlight expected type is unsupported: ${expectedType}.`
    );
  }
  if (value.type !== expectedType) {
    throw new TypeError(
      `${label} type must be exactly "${expectedType}".`
    );
  }
  requireCellIndices(
    expectedCellIndices,
    `${label} source cellIndices`,
    { allowEmpty: false, pointCount }
  );
  if (value.cellCount !== expectedCellIndices.length) {
    throw new RangeError(
      `${label} cellCount must match the completed selection.`
    );
  }
  // Both are cell lists, so equal sets are equal lists. A permuted, offset,
  // or substituted index set is rejected here instead of being saved as a
  // selection nobody made.
  if (!cellListsEqual(value.cellIndices, expectedCellIndices)) {
    throw new RangeError(
      `${label} cellIndices must be exactly the completed selection.`
    );
  }
  return value;
}

export function requireCompletedSelectionEvent(event, type, pointCount) {
  requireExactKeys(
    event,
    ['type', 'cellIndices', 'cellCount', 'steps'],
    `${type} selection event`
  );
  if (event.type !== type) {
    throw new TypeError(
      `${type} selection event type must be exactly "${type}".`
    );
  }
  requireCellIndices(
    event.cellIndices,
    `${type} selection cellIndices`,
    { allowEmpty: false, pointCount }
  );
  requireSafeInteger(event.cellCount, `${type} selection cellCount`, 1);
  if (event.cellCount !== event.cellIndices.length) {
    throw new RangeError(
      `${type} selection cellCount must equal cellIndices length.`
    );
  }
  requireSafeInteger(event.steps, `${type} selection steps`, 1);
  return event;
}

function requireCancelledStep(event, tool, includeCandidates, pointCount) {
  const keys = includeCandidates
    ? ['cancelled', 'step', 'candidateCount', 'candidates']
    : ['cancelled', 'step', 'candidateCount'];
  requireExactKeys(event, keys, `${tool} cancelled step event`);
  if (
    event.cancelled !== true
    || event.step !== 0
    || event.candidateCount !== 0
  ) {
    throw new TypeError(
      `${tool} cancelled step must publish cancelled true with zero counts.`
    );
  }
  if (includeCandidates) {
    requireCellIndices(
      event.candidates,
      `${tool} cancelled step candidates`,
      { allowEmpty: true, pointCount }
    );
    if (event.candidates.length !== 0) {
      throw new TypeError(`${tool} cancelled step candidates must be empty.`);
    }
  }
  return event;
}

/**
 * An input gesture the renderer consumed and could not turn into a step.
 *
 * It is not a cancellation: the standing selection survives it untouched, and
 * the tool answers by repainting exactly what it already holds with one
 * explanatory line. The renderer names the cause and never the wording.
 */
function requireAbandonedStep(event, tool) {
  requireExactKeys(
    event,
    ['abandoned', 'step', 'candidateCount'],
    `${tool} abandoned step event`
  );
  const reasons = tool === 'annotation'
    ? ANNOTATION_ABANDONED_GESTURE_REASONS
    : ABANDONED_GESTURE_REASONS;
  if (!reasons.includes(event.abandoned)) {
    throw new TypeError(
      `${tool} abandoned step reason must be exactly `
      + `${reasons.join(' or ')}.`
    );
  }
  if (event.step !== 0 || event.candidateCount !== 0) {
    throw new TypeError(
      `${tool} abandoned step must publish zero counts.`
    );
  }
  return event;
}

export function requireSelectionStepEvent(
  event,
  tool,
  pointCount,
  extraKeys = []
) {
  if (isObjectRecord(event) && event.cancelled === true) {
    return requireCancelledStep(
      event,
      tool,
      tool !== 'annotation',
      pointCount
    );
  }
  if (isObjectRecord(event) && event.abandoned !== undefined) {
    return requireAbandonedStep(event, tool);
  }
  requireExactKeys(
    event,
    ['step', 'candidateCount', 'candidates', 'mode', ...extraKeys],
    `${tool} step event`
  );
  requireSafeInteger(event.step, `${tool} step`, 1);
  requireCellIndices(
    event.candidates,
    `${tool} step candidates`,
    { allowEmpty: true, pointCount }
  );
  requireSafeInteger(
    event.candidateCount,
    `${tool} step candidateCount`,
    0
  );
  if (event.candidateCount !== event.candidates.length) {
    throw new RangeError(
      `${tool} step candidateCount must equal candidates length.`
    );
  }
  requireCombineMode(event.mode, `${tool} step`);
  return event;
}

export function requireAnnotationStepEvent(event, pointCount) {
  if (isObjectRecord(event) && event.cancelled === true) {
    return requireCancelledStep(event, 'annotation', false, pointCount);
  }
  if (isObjectRecord(event) && event.abandoned !== undefined) {
    return requireAbandonedStep(event, 'annotation');
  }
  requireExactKeys(
    event,
    [
      'type',
      'cellIndex',
      'dragDeltaY',
      'startX',
      'startY',
      'endX',
      'endY',
      'mode',
      'viewId'
    ],
    'annotation step event'
  );
  if (event.type !== 'click' && event.type !== 'range') {
    throw new TypeError(
      'Annotation step type must be exactly "click" or "range".'
    );
  }
  requireCellIndex(event.cellIndex, 'Annotation step cellIndex', pointCount);
  for (const key of [
    'dragDeltaY',
    'startX',
    'startY',
    'endX',
    'endY'
  ]) {
    requireFiniteNumber(event[key], `Annotation step ${key}`);
  }
  requireCombineMode(event.mode, 'Annotation step');
  if (
    typeof event.viewId !== 'string'
    || event.viewId.length === 0
    || event.viewId !== event.viewId.trim()
  ) {
    throw new TypeError(
      'Annotation step viewId must be a nonempty trimmed string.'
    );
  }
  return event;
}

export function requireContinuousPreviewEvent(event, pointCount) {
  requireExactKeys(
    event,
    [
      'type',
      'cellIndex',
      'dragDeltaY',
      'startX',
      'startY',
      'endX',
      'endY',
      'mode',
      'viewId'
    ],
    'continuous preview event'
  );
  if (event.type !== 'preview') {
    throw new TypeError(
      'Continuous preview event type must be exactly "preview".'
    );
  }
  requireCellIndex(
    event.cellIndex,
    'Continuous preview cellIndex',
    pointCount
  );
  for (const key of [
    'dragDeltaY',
    'startX',
    'startY',
    'endX',
    'endY'
  ]) {
    requireFiniteNumber(event[key], `Continuous preview ${key}`);
  }
  requireCombineMode(event.mode, 'Continuous preview');
  if (
    typeof event.viewId !== 'string'
    || event.viewId.length === 0
    || event.viewId !== event.viewId.trim()
  ) {
    throw new TypeError(
      'Continuous preview viewId must be a nonempty trimmed string.'
    );
  }
  return event;
}

export function requireSelectionPreviewEvent(
  event,
  tool,
  pointCount,
  extraKeys
) {
  requireExactKeys(
    event,
    ['type', 'cellIndices', 'cellCount', ...extraKeys],
    `${tool} preview event`
  );
  if (event.type !== `${tool}-preview`) {
    throw new TypeError(
      `${tool} preview event type must be exactly "${tool}-preview".`
    );
  }
  requireCellIndices(
    event.cellIndices,
    `${tool} preview cellIndices`,
    { allowEmpty: true, pointCount }
  );
  requireSafeInteger(event.cellCount, `${tool} preview cellCount`, 0);
  if (event.cellCount !== event.cellIndices.length) {
    throw new RangeError(
      `${tool} preview cellCount must equal cellIndices length.`
    );
  }
  return event;
}

export function requireContinuousStatistics(field) {
  if (!isObjectRecord(field) || field.kind !== 'continuous') {
    throw new TypeError('Highlight field must be continuous.');
  }
  const statistics = field._continuousStats;
  requireExactKeys(
    statistics,
    ['min', 'max'],
    'Continuous highlight statistics'
  );
  requireFiniteNumber(statistics.min, 'Continuous highlight statistics min');
  requireFiniteNumber(statistics.max, 'Continuous highlight statistics max');
  if (statistics.min > statistics.max) {
    throw new RangeError(
      'Continuous highlight statistics min must not exceed max.'
    );
  }
  return statistics;
}

export function requireUnifiedSelectionState(value, pointCount) {
  requireExactKeys(
    value,
    ['inProgress', 'stepCount', 'candidateCount', 'candidates'],
    'Unified highlight selection state'
  );
  requirePointCount(pointCount, 'Unified highlight selection state');
  if (typeof value.inProgress !== 'boolean') {
    throw new TypeError(
      'Unified highlight selection inProgress must be boolean.'
    );
  }
  requireSafeInteger(
    value.stepCount,
    'Unified highlight selection stepCount',
    0
  );
  requireSafeInteger(
    value.candidateCount,
    'Unified highlight selection candidateCount',
    0
  );
  requireCellIndices(
    value.candidates,
    'Unified highlight selection candidates',
    { allowEmpty: true, pointCount }
  );
  if (value.candidateCount !== value.candidates.length) {
    throw new RangeError(
      'Unified highlight selection candidateCount must equal candidates length.'
    );
  }
  if (
    value.inProgress === false
    && (
      value.stepCount !== 0
      || value.candidateCount !== 0
      || value.candidates.length !== 0
    )
  ) {
    throw new TypeError(
      'Inactive unified highlight selection state must contain zero counts.'
    );
  }
  if (value.inProgress === true && value.stepCount < 1) {
    throw new TypeError(
      'Active unified highlight selection state requires a positive stepCount.'
    );
  }
  return value;
}

export function requireLodChangeEvent(value) {
  requireExactKeys(
    value,
    [
      'dimensionLevel',
      'geometryGeneration',
      'lodLevel',
      'viewId'
    ],
    'Highlight LOD change event'
  );
  if (!Object.isFrozen(value)) {
    throw new TypeError('Highlight LOD change event must be frozen.');
  }
  if (
    typeof value.viewId !== 'string'
    || value.viewId.length === 0
    || value.viewId !== value.viewId.trim()
  ) {
    throw new TypeError(
      'Highlight LOD change viewId must be a nonempty trimmed string.'
    );
  }
  requireSafeInteger(
    value.dimensionLevel,
    'Highlight LOD change dimension',
    1
  );
  if (value.dimensionLevel > 3) {
    throw new TypeError(
      'Highlight LOD change dimension must be 1, 2, or 3.'
    );
  }
  requireSafeInteger(
    value.geometryGeneration,
    'Highlight LOD change geometry generation',
    1
  );
  requireSafeInteger(value.lodLevel, 'Highlight LOD change level', -1);
  return value;
}

export function requireModeButtons(buttons) {
  if (!Array.isArray(buttons) || buttons.length !== SELECTION_MODES.length) {
    throw new TypeError(
      'Highlight modeButtons must contain exactly four current-mode buttons.'
    );
  }
  const modes = new Set();
  let pressedCount = 0;
  let pressedMode = null;
  for (const button of buttons) {
    requireDomElement(
      button,
      'Highlight mode button',
      ['addEventListener', 'getAttribute', 'setAttribute']
    );
    if (!isObjectRecord(button.dataset)) {
      throw new TypeError('Highlight mode button must expose a dataset object.');
    }
    const mode = requireHighlightSelectionMode(button.dataset.mode);
    if (modes.has(mode)) {
      throw new TypeError(`Duplicate highlight mode button: ${mode}.`);
    }
    modes.add(mode);
    const pressed = button.getAttribute('aria-pressed');
    if (pressed !== null && pressed !== 'true' && pressed !== 'false') {
      throw new TypeError(
        'Highlight mode button aria-pressed must be "true", "false", or absent.'
      );
    }
    if (pressed === 'true') {
      pressedCount += 1;
      pressedMode = mode;
    }
  }
  if (pressedCount !== 1) {
    throw new TypeError(
      'Highlight mode buttons require exactly one aria-pressed="true" button.'
    );
  }
  return { buttons, pressedMode };
}

export function requireViewerHostSource(viewerHostSource) {
  if (viewerHostSource === null) return null;
  requireMethods(
    viewerHostSource,
    'Highlight viewer host source',
    ['notifySelection']
  );
  return viewerHostSource;
}

/**
 * The DOM the Select mode surfaces need, passed down unchanged from the DOM
 * cache to mode-ui.js: the switches and combine buttons of the panel and the
 * selection bar, and the bar's step row and step buttons.
 */
export const SELECT_MODE_DOM_KEYS = Object.freeze([
  'selectModeSwitches',
  'selectCombineGroups',
  'selectCombineButtons',
  'selectBarSteps',
  'selectBarStepButtons'
]);

/**
 * @param {object} dom
 * @returns {object} exactly the SELECT_MODE_DOM_KEYS entries of `dom`
 */
export function pickSelectModeDom(dom) {
  return Object.fromEntries(SELECT_MODE_DOM_KEYS.map(key => [key, dom[key]]));
}

function readExactBoolean(button, attribute, label) {
  const value = button.getAttribute(attribute);
  if (value !== 'true' && value !== 'false') {
    throw new TypeError(`${label} ${attribute} must be exactly "true" or "false".`);
  }
  return value === 'true';
}

/**
 * Validate the Select mode controls and read the state their markup declares.
 *
 * Select mode has one switch and one combine choice, drawn on more than one
 * surface (the Highlighting panel and the selection bar over the plot). Every
 * switch must therefore show the same state, every combine group must offer
 * each combine exactly once, and every button for one combine must agree, with
 * exactly one combine pressed.
 *
 * @param {object} controls
 * @param {HTMLElement[]} controls.switches every Select mode switch
 * @param {HTMLElement[]} controls.combineGroups every combine group
 * @param {HTMLElement[]} controls.combineButtons every combine button
 * @param {readonly string[]} combines
 * @returns {{enabled: boolean, combine: string}}
 */
export function requireSelectModeControls(controls, combines) {
  requireExactKeys(
    controls,
    ['switches', 'combineGroups', 'combineButtons'],
    'Select mode controls'
  );
  const { switches, combineGroups, combineButtons } = controls;
  if (!Array.isArray(switches) || switches.length === 0) {
    throw new TypeError('Select mode needs at least one switch.');
  }
  let enabled = null;
  for (const control of switches) {
    requireDomElement(
      control,
      'Select mode switch',
      ['addEventListener', 'getAttribute', 'setAttribute']
    );
    if (control.getAttribute('role') !== 'switch') {
      throw new TypeError('Select mode switch must carry role="switch".');
    }
    const checked = readExactBoolean(control, 'aria-checked', 'Select mode switch');
    if (enabled !== null && checked !== enabled) {
      throw new TypeError('Every Select mode switch must show the same state.');
    }
    enabled = checked;
  }
  if (!Array.isArray(combineGroups) || combineGroups.length !== switches.length) {
    throw new TypeError('Select mode needs one combine group per switch.');
  }
  for (const group of combineGroups) {
    requireDomElement(group, 'Select mode combine group');
  }
  if (
    !Array.isArray(combineButtons)
    || combineButtons.length !== combines.length * combineGroups.length
  ) {
    throw new TypeError(
      `Select mode needs exactly ${combines.length} combine buttons per group.`
    );
  }
  const counts = new Map(combines.map(name => [name, 0]));
  const pressedByCombine = new Map();
  for (const button of combineButtons) {
    requireDomElement(
      button,
      'Select mode combine button',
      ['addEventListener', 'getAttribute', 'setAttribute']
    );
    if (!isObjectRecord(button.dataset) || !combines.includes(button.dataset.combine)) {
      throw new TypeError(
        'Select mode combine button must name one combine in data-combine.'
      );
    }
    const name = button.dataset.combine;
    counts.set(name, counts.get(name) + 1);
    const pressed = readExactBoolean(
      button,
      'aria-pressed',
      'Select mode combine button'
    );
    if (pressedByCombine.has(name) && pressedByCombine.get(name) !== pressed) {
      throw new TypeError(
        `Every Select mode ${name} button must show the same state.`
      );
    }
    pressedByCombine.set(name, pressed);
  }
  for (const [name, count] of counts) {
    if (count !== combineGroups.length) {
      throw new TypeError(
        `Select mode needs one ${name} button in every combine group.`
      );
    }
  }
  const pressedCombines = combines.filter(name => pressedByCombine.get(name));
  if (pressedCombines.length !== 1) {
    throw new TypeError('Exactly one Select mode combine must be pressed.');
  }
  return { enabled, combine: pressedCombines[0] };
}
