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

import { CellSet } from '../../../utils/cell-set.js';
import {
  requireContinuousStatistics,
  requireFiniteNumber,
  requireSafeInteger
} from './exact-contract.js';
import { isCategoricalCodes, missingCategoryCode } from '../../../../data/categorical-storage-contract.js';

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
 * The field an annotation gesture in one pane reads: the field that pane is
 * colored by, or `null` when it is colored by none.
 *
 * A selection gesture never moves view focus, so in a grid of views the pane
 * a gesture lands in need not be the focused one. Its category, value and
 * range are therefore read from that pane's own field — never from the
 * focused view's — exactly as its visibility comes from that pane's own
 * transparency (`viewer.getViewTransparency(viewId)`).
 *
 * @param {import('../../../state/core/data-state.js').DataState} state
 * @param {string} viewId Pane the gesture landed in.
 * @returns {object|null}
 */
export function annotationFieldForPane(state, viewId) {
  const field = state.getFieldForView(viewId);
  if (field === null || field === undefined) return null;
  if (field.kind !== 'category' && field.kind !== 'continuous') {
    throw new TypeError(
      `Unknown annotation field kind: ${String(field.kind)}.`
    );
  }
  return field;
}

/**
 * The renderer's name for the kind of field one pane is colored by.
 *
 * This is what the viewer is handed as its view field kind source
 * (`viewer.setViewFieldKindSource`): it decides, per pane and at the moment of
 * the press, whether an annotation gesture there can start, and which cursor
 * the armed tool shows over that pane.
 *
 * @param {import('../../../state/core/data-state.js').DataState} state
 * @param {string} viewId
 * @returns {'none'|'continuous'|'categorical'}
 */
export function annotationFieldKindForPane(state, viewId) {
  const field = annotationFieldForPane(state, viewId);
  if (field === null) return 'none';
  return field.kind === 'category' ? 'categorical' : 'continuous';
}

/**
 * Resolve the cells an annotation gesture covers on the field of the pane it
 * landed in.
 *
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.field Field of the pane, from `annotationFieldForPane`.
 * @param {number} options.cellIndex Cell the gesture started on.
 * @param {'click'|'range'} options.gestureType
 * @param {number} options.dragDeltaY
 * @param {Uint8Array} options.viewTransparency Transparency of the same pane.
 * @returns {{cellIndices: number[], range: {minVal: number, maxVal: number}|null}}
 */
export function computeAnnotationGestureCells(options) {
  const {
    state,
    field,
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
  requireSafeInteger(cellIndex, 'Annotation gesture cellIndex', 0);
  if (cellIndex >= state.pointCount) {
    throw new RangeError(
      'Annotation gesture cellIndex is outside the current dataset.'
    );
  }

  if (field.kind === 'category') {
    const codes = field.codes;
    if (!isCategoricalCodes(codes) || codes.length !== state.pointCount) {
      throw new TypeError(
        'Annotation category codes must be a Uint8Array, Uint16Array or Uint32Array with one code per cell.'
      );
    }
    const missingCode = missingCategoryCode(codes);
    const categoryIndex = codes[cellIndex];
    if (categoryIndex === missingCode) {
      return { cellIndices: [], range: null };
    }
    if (
      !Array.isArray(field.categories)
      || categoryIndex >= field.categories.length
    ) {
      throw new RangeError(
        'Annotation category index is outside the field\'s categories.'
      );
    }
    return {
      cellIndices: state.getCellIndicesForCategory(
        field,
        categoryIndex,
        viewTransparency
      ),
      range: null
    };
  }

  if (field.kind === 'continuous') {
    const values = field.values;
    if (
      (!(values instanceof Float32Array) && !(values instanceof Float64Array))
      || values.length !== state.pointCount
    ) {
      throw new TypeError(
        'Annotation continuous values must be a Float32Array or Float64Array with one value per cell.'
      );
    }
    const clickedValue = values[cellIndex];
    if (Number.isNaN(clickedValue)) return { cellIndices: [], range: null };
    if (!Number.isFinite(clickedValue)) {
      throw new TypeError(
        'Annotation continuous value must be finite or NaN.'
      );
    }

    const stats = requireContinuousStatistics(field);
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
        field,
        minVal,
        maxVal,
        viewTransparency
      ),
      range: { minVal, maxVal }
    };
  }

  throw new TypeError(
    `Unknown annotation field kind: ${field.kind}.`
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
 * @param {CellSet|null} options.candidates
 * @param {number[]} options.cellIndices
 * @param {'intersect'|'union'|'subtract'} options.mode
 * @param {string} options.fieldKind
 * @param {number} options.cellCount - Cells in the dataset.
 * @returns {{candidates: CellSet|null, effectiveMode: string}}
 */
export function combineAnnotationCandidates(options) {
  const { candidates, cellIndices, mode, fieldKind, cellCount } = options;
  if (candidates !== null && !(candidates instanceof CellSet)) {
    throw new TypeError(
      'Annotation candidate combine requires a CellSet or null.'
    );
  }
  if (!Array.isArray(cellIndices)) {
    throw new TypeError(
      'Annotation candidate combine requires an array of cell indices.'
    );
  }

  // Candidates are a CellSet: a JS Set refuses more than 2^24 cells.
  const incoming = CellSet.from(cellIndices, candidates?.cellCount ?? cellCount);
  if (fieldKind === 'category') {
    if (mode === 'intersect') {
      return { candidates: incoming, effectiveMode: 'replace' };
    }
    if (mode === 'union') {
      if (candidates === null) {
        return { candidates: incoming, effectiveMode: 'union' };
      }
      return { candidates: candidates.clone().unionWith(incoming), effectiveMode: 'union' };
    }
    if (candidates === null) {
      return { candidates: null, effectiveMode: 'subtract' };
    }
    return { candidates: candidates.clone().subtract(incoming), effectiveMode: 'subtract' };
  }

  if (candidates === null) {
    return {
      candidates: mode === 'subtract' ? null : incoming,
      effectiveMode: mode
    };
  }
  if (mode === 'union') {
    return { candidates: candidates.clone().unionWith(incoming), effectiveMode: 'union' };
  }
  if (mode === 'subtract') {
    return { candidates: candidates.clone().subtract(incoming), effectiveMode: 'subtract' };
  }
  return { candidates: candidates.clone().intersectWith(incoming), effectiveMode: 'intersect' };
}
