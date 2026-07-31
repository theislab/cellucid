/**
 * @fileoverview One definition of what an annotation gesture selects.
 *
 * The annotation tool answers the same two questions twice: once while the
 * pointer is still down (the live preview) and once when it is released (the
 * committed step). Both answers must be identical or the preview lies about
 * what confirming will produce, so the cell lookup and the combine rules live
 * here and are shared by `annotation-selection.js` and the drag preview in
 * `continuous-selection-preview.js`.
 *
 * @module ui/modules/highlight/annotation-cells
 */

import {
  requireContinuousStatistics,
  requireFieldSource,
  requireFiniteNumber,
  requireSafeInteger
} from './exact-contract.js';

/**
 * Vertical travel, in CSS pixels, above which the renderer reports a drag as a
 * `range` gesture instead of a `click`. Mirrors the threshold applied in
 * `rendering/highlight-renderer.js` when it publishes the completed step, so a
 * preview computed mid-drag predicts the step that release will publish.
 */
export const ANNOTATION_RANGE_DRAG_THRESHOLD_PX = 10;

/** Value-per-pixel scale used to turn vertical drag into a value range. */
const ANNOTATION_DRAG_VALUE_SCALE = 0.005;

/** Width of the implicit range a plain click selects, as a fraction of range. */
const ANNOTATION_CLICK_RANGE_FRACTION = 0.1;

/**
 * Classify an in-flight annotation drag exactly the way the renderer will
 * classify it on release.
 *
 * @param {number} dragDeltaY
 * @returns {'click'|'range'}
 */
export function annotationGestureType(dragDeltaY) {
  requireFiniteNumber(dragDeltaY, 'Annotation gesture dragDeltaY');
  return Math.abs(dragDeltaY) > ANNOTATION_RANGE_DRAG_THRESHOLD_PX
    ? 'range'
    : 'click';
}

/**
 * Resolve the cells an annotation gesture covers on the active field.
 *
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {{kind: string, categories?: string[], codes?: ArrayBufferView}} options.activeField
 * @param {number} options.cellIndex Cell the gesture started on.
 * @param {'click'|'range'} options.gestureType
 * @param {number} options.dragDeltaY
 * @param {Float32Array|null} options.viewTransparency
 * @returns {{cellIndices: number[], range: {minVal: number, maxVal: number}|null}}
 */
export function computeAnnotationGestureCells(options) {
  const {
    state,
    activeField,
    cellIndex,
    gestureType,
    dragDeltaY,
    viewTransparency
  } = options;
  if (gestureType !== 'click' && gestureType !== 'range') {
    throw new TypeError(
      'Annotation gesture type must be exactly "click" or "range".'
    );
  }
  requireFiniteNumber(dragDeltaY, 'Annotation gesture dragDeltaY');
  const source = requireFieldSource(state.activeFieldSource);
  const fieldIndex = source === 'var'
    ? state.activeVarFieldIndex
    : state.activeFieldIndex;
  requireSafeInteger(fieldIndex, 'Annotation active field index', 0);

  if (activeField.kind === 'category') {
    const categoryIndex = state.getCategoryForCell(
      cellIndex,
      fieldIndex,
      source
    );
    const missingCode = activeField.codes instanceof Uint8Array
      ? 255
      : activeField.codes instanceof Uint16Array
        ? 65_535
        : null;
    if (missingCode === null) {
      throw new TypeError(
        'Annotation category codes must be Uint8Array or Uint16Array.'
      );
    }
    if (categoryIndex === missingCode) {
      return { cellIndices: [], range: null };
    }
    requireSafeInteger(categoryIndex, 'Annotation category index', 0);
    if (
      !Array.isArray(activeField.categories)
      || categoryIndex >= activeField.categories.length
    ) {
      throw new RangeError(
        'Annotation category index is outside the active categories.'
      );
    }
    return {
      cellIndices: state.getCellIndicesForCategory(
        fieldIndex,
        categoryIndex,
        source,
        viewTransparency
      ),
      range: null
    };
  }

  if (activeField.kind === 'continuous') {
    const clickedValue = state.getValueForCell(cellIndex, fieldIndex, source);
    if (Number.isNaN(clickedValue)) return { cellIndices: [], range: null };
    if (!Number.isFinite(clickedValue)) {
      throw new TypeError(
        'Annotation continuous value must be finite or NaN.'
      );
    }

    const stats = requireContinuousStatistics(activeField);
    const valueRange = stats.max - stats.min;

    let minVal;
    let maxVal;
    if (gestureType === 'range' && dragDeltaY !== 0) {
      const dragAmount =
        -dragDeltaY * ANNOTATION_DRAG_VALUE_SCALE * valueRange;
      if (dragAmount > 0) {
        minVal = clickedValue;
        maxVal = Math.min(stats.max, clickedValue + dragAmount);
      } else {
        minVal = Math.max(stats.min, clickedValue + dragAmount);
        maxVal = clickedValue;
      }
    } else {
      const rangeSize = valueRange * ANNOTATION_CLICK_RANGE_FRACTION;
      minVal = Math.max(stats.min, clickedValue - rangeSize / 2);
      maxVal = Math.min(stats.max, clickedValue + rangeSize / 2);
    }

    return {
      cellIndices: state.getCellIndicesForRange(
        fieldIndex,
        minVal,
        maxVal,
        source,
        viewTransparency
      ),
      range: { minVal, maxVal }
    };
  }

  throw new TypeError(
    `Unknown annotation field kind: ${activeField.kind}.`
  );
}

/**
 * Combine a gesture's cells with the in-progress candidate set.
 *
 * Categorical fields replace on a plain Alt gesture (there is nothing sensible
 * to intersect a single category with); continuous fields intersect. Returning
 * `null` means the gesture leaves the tool with no candidate set at all, which
 * is how a subtract before any selection behaves.
 *
 * @param {object} options
 * @param {Set<number>|null} options.candidates
 * @param {number[]} options.cellIndices
 * @param {'intersect'|'union'|'subtract'} options.mode
 * @param {string} options.fieldKind
 * @returns {{candidates: Set<number>|null, effectiveMode: string}}
 */
export function combineAnnotationCandidates(options) {
  const { candidates, cellIndices, mode, fieldKind } = options;
  if (candidates !== null && !(candidates instanceof Set)) {
    throw new TypeError(
      'Annotation candidate combine requires a Set or null.'
    );
  }
  if (!Array.isArray(cellIndices)) {
    throw new TypeError(
      'Annotation candidate combine requires an array of cell indices.'
    );
  }

  if (fieldKind === 'category') {
    if (mode === 'intersect') {
      return { candidates: new Set(cellIndices), effectiveMode: 'replace' };
    }
    if (mode === 'union') {
      if (candidates === null) {
        return { candidates: new Set(cellIndices), effectiveMode: 'union' };
      }
      const next = new Set(candidates);
      for (const cellIndex of cellIndices) next.add(cellIndex);
      return { candidates: next, effectiveMode: 'union' };
    }
    if (candidates === null) {
      return { candidates: null, effectiveMode: 'subtract' };
    }
    const next = new Set(candidates);
    for (const cellIndex of cellIndices) next.delete(cellIndex);
    return { candidates: next, effectiveMode: 'subtract' };
  }

  if (candidates === null) {
    return {
      candidates: mode === 'subtract' ? null : new Set(cellIndices),
      effectiveMode: mode
    };
  }
  if (mode === 'union') {
    const next = new Set(candidates);
    for (const cellIndex of cellIndices) next.add(cellIndex);
    return { candidates: next, effectiveMode: 'union' };
  }
  if (mode === 'subtract') {
    const next = new Set(candidates);
    for (const cellIndex of cellIndices) next.delete(cellIndex);
    return { candidates: next, effectiveMode: 'subtract' };
  }
  const incoming = new Set(cellIndices);
  const next = new Set();
  for (const cellIndex of candidates) {
    if (incoming.has(cellIndex)) next.add(cellIndex);
  }
  return { candidates: next, effectiveMode: 'intersect' };
}
