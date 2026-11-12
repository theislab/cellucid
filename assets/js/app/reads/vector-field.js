/**
 * @fileoverview Where the cells of each category are heading along a vector
 * field (`vector-field.summary`, `app/actions/definitions/reads.js`): what an
 * agent needs to say where RNA velocity points from the data, not from a
 * picture of moving particles or from the textbook (bug hunt live pass 5,
 * L18-1: "the tools don't give me the velocity numbers").
 *
 * Read in the embedding a view shows, from the vectors as the overlay draws
 * them (`data/vector-field-manager.js`: scaled into the embedding's render
 * space, beside its positions). Per category of a field:
 *
 * - speed: the mean length of its cells' vectors over the mean of every cell
 *   read (1 = as fast as the average cell; a mean, so no one cell's value);
 * - coherence: the length of the mean of its cells' unit vectors (1: all
 *   point one way; near 0: every way, or still);
 * - direction: that mean as a unit vector, and on a 2-D view in words;
 * - towards: each cell's arrow is shared among its k nearest cells in the
 *   embedding by how directly it points at each (the cosine between the
 *   vector and the step to that cell, a negative one counting zero), as
 *   scVelo's velocity graph shares it among neighbors in gene space; a
 *   category's share into each category is the mean over its cells.
 *
 * Nearest cells come from a uniform grid over the cells read, searched ring
 * by ring until the k-th nearest is certain. A summary of groups, never a
 * value of one cell (`agent/bridge/data-guard.js`).
 *
 * @module app/reads/vector-field
 */

import { ActionRefused } from '../actions/dispatcher.js';
import { FieldKind } from '../utils/field-constants.js';
import { missingCategoryCode } from '../../data/categorical-storage-contract.js';
import { MappingLoadError } from '../../data/data-mapping-candidates.js';
import { categoryDisplayName, listNames, quoteName } from '../actions/targets/names.js';
import { resolveCategory, resolveField } from '../actions/targets/fields.js';
import { resolveViewName, viewNameOf } from '../actions/targets/views.js';
import { formatCountOf } from '../../utils/format-units.js';
import { PLACES, placePath } from '../ui/place-names.js';
import { readShownVectorFieldId } from '../ui/modules/figure-export/utils/overlay-fidelity.js';
import { NO_DATASET_OPEN } from '../ui/no-dataset.js';

/** Below this coherence a group's arrows point every way: no heading is said. */
const ALIGNED = 0.2;
/** Shares under this are left out of `towards`. */
const SHOWN_SHARE = 0.02;

const round2 = value => Math.round(value * 100) / 100;

/** A 2-D direction in words, as drawn (x right, y up). */
export function headingWords(x, y) {
  const names = ['right', 'up and right', 'up', 'up and left', 'left', 'down and left', 'down', 'down and right'];
  const angle = Math.atan2(y, x);
  return names[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
}

/**
 * The k nearest of the `cells` (indices) for each of them, by a uniform grid
 * over their positions: `Int32Array` rows of k (fewer cells than k + 1: all
 * the others), -1 where there are none.
 */
function nearestCells(positions, dimension, cells, k) {
  const n = cells.length;
  const lo = new Float64Array(dimension).fill(Infinity);
  const hi = new Float64Array(dimension).fill(-Infinity);
  for (const i of cells) {
    for (let a = 0; a < dimension; a++) {
      const v = positions[i * dimension + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  // Grid cells of about k / 2 points each over the box the cells span, over
  // the axes they spread along (a flat axis, as z of cells in a plane, is
  // one grid cell thick).
  const extents = Array.from({ length: dimension }, (_, a) => Math.max(0, hi[a] - lo[a]));
  const widest = Math.max(...extents);
  const spread = extents.filter(extent => extent > widest * 1e-6);
  let volume = 1;
  for (const extent of spread) volume *= extent;
  const size = spread.length === 0 ? 1 : Math.pow((volume * Math.max(1, k / 2)) / n, 1 / spread.length);
  const span = extents.map(extent => Math.max(1, Math.floor(extent / size) + 1));
  const cellOf = (i, a) => Math.min(span[a] - 1, Math.floor((positions[i * dimension + a] - lo[a]) / size));
  const keyOf = coords => coords.reduce((key, c, a) => key * span[a] + c, 0);
  const buckets = new Map();
  for (const i of cells) {
    const key = keyOf(Array.from({ length: dimension }, (_, a) => cellOf(i, a)));
    let bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, (bucket = []));
    bucket.push(i);
  }
  const want = Math.min(k, n - 1);
  const out = new Int32Array(n * k).fill(-1);
  const maxRing = Math.max(...span);
  const found = [];
  cells.forEach((i, row) => {
    const home = Array.from({ length: dimension }, (_, a) => cellOf(i, a));
    found.length = 0;
    for (let ring = 0; ring <= maxRing; ring++) {
      // The cells of this ring: every grid cell at Chebyshev distance `ring`.
      const offsets = [];
      const walk = (a, acc, edge) => {
        if (a === dimension) {
          if (edge || ring === 0) offsets.push(acc.slice());
          return;
        }
        for (let d = -ring; d <= ring; d++) {
          const c = home[a] + d;
          if (c < 0 || c >= span[a]) continue;
          acc.push(c);
          walk(a + 1, acc, edge || Math.abs(d) === ring);
          acc.pop();
        }
      };
      walk(0, [], false);
      for (const coords of offsets) {
        const bucket = buckets.get(keyOf(coords));
        if (bucket === undefined) continue;
        for (const j of bucket) {
          if (j === i) continue;
          let d2 = 0;
          for (let a = 0; a < dimension; a++) {
            const d = positions[j * dimension + a] - positions[i * dimension + a];
            d2 += d * d;
          }
          found.push([d2, j]);
        }
      }
      if (found.length >= want) {
        found.sort((x, y) => x[0] - y[0]);
        // Exact once the k-th is no farther than the searched rings reach.
        const reach = ring * size;
        if (want === 0 || found[want - 1][0] <= reach * reach) break;
      }
    }
    found.sort((x, y) => x[0] - y[0]);
    for (let m = 0; m < want; m++) out[row * k + m] = found[m][1];
  });
  return out;
}

/**
 * The summary over arrays (pure; the read gathers them).
 *
 * @param {{positions: Float32Array, vectors: Float32Array, dimension: number,
 *   codes: ArrayLike<number>, categoryCount: number, include: (i: number) => boolean,
 *   neighbors: number, wanted: Set<number>|null}} input
 */
export function summarizeFlow({ positions, vectors, dimension, codes, categoryCount, include, neighbors, wanted = null }) {
  const missing = missingCategoryCode(codes);
  const cells = [];
  let withoutVector = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === missing || code >= categoryCount || !include(i)) continue;
    let finite = true;
    for (let a = 0; a < dimension; a++) if (!Number.isFinite(vectors[i * dimension + a])) finite = false;
    if (!finite) { withoutVector++; continue; }
    cells.push(i);
  }
  const speeds = new Float64Array(cells.length);
  cells.forEach((i, row) => {
    let s = 0;
    for (let a = 0; a < dimension; a++) s += vectors[i * dimension + a] ** 2;
    speeds[row] = Math.sqrt(s);
  });
  let sum = 0;
  for (const value of speeds) sum += value;
  const typical = cells.length > 0 && sum > 0 ? sum / cells.length : 1;
  const near = nearestCells(positions, dimension, cells, neighbors);

  const groupSpeeds = new Float64Array(categoryCount);
  const unitSums = Array.from({ length: categoryCount }, () => new Float64Array(dimension));
  const flow = Array.from({ length: categoryCount }, () => new Float64Array(categoryCount));
  const flowing = new Float64Array(categoryCount);
  const count = new Int32Array(categoryCount);
  cells.forEach((i, row) => {
    const code = codes[i];
    count[code]++;
    groupSpeeds[code] += speeds[row];
    const speed = speeds[row];
    if (!(speed > 0)) return;
    for (let a = 0; a < dimension; a++) unitSums[code][a] += vectors[i * dimension + a] / speed;
    // Share the arrow among the nearest cells by how directly it points at each.
    let total = 0;
    const weights = [];
    for (let m = 0; m < neighbors; m++) {
      const j = near[row * neighbors + m];
      if (j < 0) break;
      let dot = 0;
      let length = 0;
      for (let a = 0; a < dimension; a++) {
        const step = positions[j * dimension + a] - positions[i * dimension + a];
        dot += step * vectors[i * dimension + a];
        length += step * step;
      }
      const cos = length > 0 ? dot / (Math.sqrt(length) * speed) : 0;
      if (cos > 0) {
        weights.push([codes[j], cos]);
        total += cos;
      }
    }
    if (total === 0) return;
    for (const [to, w] of weights) flow[code][to] += w / total;
    flowing[code]++;
  });

  const groups = [];
  let empty = 0;
  for (let code = 0; code < categoryCount; code++) {
    if (wanted !== null && !wanted.has(code)) continue;
    if (count[code] === 0) { empty++; continue; }
    const mean = Array.from(unitSums[code], value => value / count[code]);
    const coherence = Math.hypot(...mean);
    const direction = coherence > 0 ? mean.map(value => round2(value / coherence)) : mean.map(() => 0);
    const towards = [];
    if (flowing[code] > 0) {
      for (let to = 0; to < categoryCount; to++) {
        const share = flow[code][to] / flowing[code];
        if (share >= SHOWN_SHARE) towards.push({ code: to, share: round2(share) });
      }
      towards.sort((a, b) => b.share - a.share);
    }
    groups.push({
      code,
      cells: count[code],
      speed: round2(groupSpeeds[code] / count[code] / typical),
      coherence: round2(coherence),
      direction,
      heading: dimension === 2 && coherence >= ALIGNED ? headingWords(mean[0], mean[1]) : null,
      towards,
    });
  }
  return { cells: cells.length, withoutVector, groups, empty };
}

/**
 * @param {{state: object, viewer: object}} owners
 */
export function createVectorFieldReads({ state, viewer }) {
  async function summary({ by, vector_field: fieldName, view, categories, neighbors = 30, visible_only: visibleOnly = false }, { signal }) {
    if (!(state.pointCount > 0)) throw new ActionRefused(NO_DATASET_OPEN, { code: 'unavailable' });
    const available = state.getAvailableVectorFields();
    if (available.length === 0) {
      throw new ActionRefused('This dataset has no vector field (a per-cell vector array in obsm, bound to an embedding).', { code: 'unavailable' });
    }
    const viewId = view === undefined ? state.getActiveViewId() : resolveViewName(viewer, view);
    const layoutKey = state.getViewLayoutKey(viewId);
    const dimensionManager = state.getDimensionManager();
    // Named as views_state and dataset_summary name embeddings ("UMAP", "PCA 1,2").
    const embeddingOf = key => {
      const layout = dimensionManager.getLayout(key);
      return { label: state.representationNameOf(layout), dimension: layout.dimension };
    };
    let field;
    if (fieldName !== undefined) {
      const wantedName = fieldName.trim().toLowerCase();
      field = available.find(each => each.id.toLowerCase() === wantedName || each.label.toLowerCase() === wantedName);
      if (field === undefined) {
        throw new ActionRefused(`This dataset has no vector field ${quoteName(fieldName)}; it has ${listNames(available.map(each => each.label))}.`, { code: 'no-target' });
      }
    } else {
      // The field the overlay shows, else the dataset's default, else the only
      // one bound to the view's embedding; among several, none is guessed.
      const bound = available.filter(each => each.layoutKeys.includes(layoutKey));
      const shown = readShownVectorFieldId(typeof document === 'undefined' ? null : document);
      const preferred = state.getDefaultVectorFieldId();
      field = bound.find(each => each.id === shown)
        ?? bound.find(each => each.id === preferred)
        ?? (bound.length === 1 ? bound[0] : undefined);
      if (field === undefined && bound.length > 1) {
        throw new ActionRefused(
          `Several vector fields are bound to ${embeddingOf(layoutKey).label} (${embeddingOf(layoutKey).dimension}-D), the embedding ${viewNameOf(viewer, viewId)} shows: ${listNames(bound.map(each => each.label))}; name one (vector_field).`,
          { code: 'ambiguous-field' },
        );
      }
      // None bound to this embedding: the refusal below names where one is.
      field ??= available.find(each => each.id === preferred) ?? available[0];
    }
    if (!field.layoutKeys.includes(layoutKey)) {
      const names = field.layoutKeys.map(key => {
        const layout = embeddingOf(key);
        return `${layout.label} (${layout.dimension}-D)`;
      });
      throw new ActionRefused(
        `${viewNameOf(viewer, viewId)} shows ${embeddingOf(layoutKey).label} (${embeddingOf(layoutKey).dimension}-D), and the vector field ${quoteName(field.label)} is bound to ${listNames(names)}: show ${names.length === 1 ? 'that embedding' : 'one of them'} in the view first (view_embedding_set).`,
        { code: 'refused' },
      );
    }

    const target = resolveField(state, by, { kind: FieldKind.CATEGORY });
    await state.ensureFieldLoaded(target.index, { silent: true, signal });
    const categoryField = resolveField(state, by, { kind: FieldKind.CATEGORY }).field;
    const wanted = categories === undefined ? null : new Set(categories.map(label => resolveCategory(categoryField, label)));

    const [data, positions] = await Promise.all([
      state.getVectorFieldManager().loadField(field.id, layoutKey).catch(error => {
        // Values the overlay cannot draw (every row NaN, past float32): a
        // refusal that says so, as the overlay's own notice does.
        if (error instanceof MappingLoadError) throw new ActionRefused(error.message, { code: 'unavailable' });
        throw error;
      }),
      dimensionManager.getPositions(layoutKey),
    ]);
    signal?.throwIfAborted?.();
    const dimension = data.components;
    if (positions.length !== data.vectors.length) {
      throw new Error(
        `The vector field "${field.label}" holds ${formatCountOf(data.vectors.length / dimension, 'cell')} and the embedding it is drawn on ${formatCountOf(positions.length / dimension, 'cell')}, so they are not of the same cells: choose the vector field again under ${placePath(PLACES.dataMapping)}, or reopen the dataset.`,
      );
    }
    let shown = null;
    if (visibleOnly) {
      shown = viewer.withBorrowedViewData(viewId, view => (view.transparency ? Float32Array.from(view.transparency) : null));
    }
    const layout = embeddingOf(layoutKey);
    const out = summarizeFlow({
      positions, vectors: data.vectors, dimension,
      codes: categoryField.codes, categoryCount: categoryField.categories.length,
      include: shown === null ? () => true : i => shown[i] > 0,
      neighbors, wanted,
    });
    if (out.cells === 0) {
      throw new ActionRefused(`No cell of ${quoteName(categoryField.key)} has a vector${visibleOnly ? ' among the cells the view shows' : ''}.`, { code: 'refused' });
    }
    const name = code => categoryDisplayName(categoryField.categories[code]);
    return {
      vector_field: field.label,
      view: viewNameOf(viewer, viewId),
      embedding: { name: layout.label, dimension: layout.dimension },
      by: categoryField.key,
      cells: out.cells,
      without_vector: out.withoutVector,
      neighbors,
      empty: out.empty,
      groups: out.groups.map(group => ({
        label: name(group.code),
        cells: group.cells,
        speed: group.speed,
        coherence: group.coherence,
        direction: group.direction,
        heading: group.heading,
        towards: group.towards.map(entry => ({ category: name(entry.code), share: entry.share })),
      })),
    };
  }
  return { summary };
}
