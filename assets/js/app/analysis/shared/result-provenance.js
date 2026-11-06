/**
 * @fileoverview What an analysis result was computed on, recorded with it.
 *
 * A result's provenance names its inputs by content, so it can be saved
 * with the result (a session, the history) and compared with the page as it
 * is now on any machine:
 *
 * - `dataset`: the dataset's id;
 * - `cells`: the open cells (their cell-set digest, how many of how many,
 *   the subsample's method and seed when they are one);
 * - `genesReadFor`: for a result that read genes for a sample of the open
 *   cells (Genes read for), that sample's size, else null;
 * - `mapping`: a digest of the data mapping (which stored arrays are read);
 * - `pages`: the highlight pages it was computed on, by name, with their
 *   cell count and a digest of their cells;
 * - `visible`: for an analysis of the visible cells, a digest of which cells
 *   the view showed, else null;
 * - `options`: the settings that decide the result (display settings are
 *   not among them: they redraw a result, they do not change it).
 *
 * `staleReasons(recorded, current)` says, one sentence each, what changed
 * since: an empty list is a current result. The app dims a stale result and
 * offers to run it again; an agent reads the same reasons
 * (`analysis.list`, `analysis.result`). A stale result is kept with its
 * provenance (a session restores it stale, never as current); it is not
 * exported or published as current.
 *
 * Digests are the history's (`app/history/value-pool.js`), so one input has
 * one name wherever it is recorded: a typed array by `typedArrayDigest` (its
 * type, length and the SHA-256 of its bytes, computed once per array: a
 * highlight group's cells are a new array whenever they change), anything
 * else by `hashValue` (the SHA-256 of its canonical JSON). The mapping's
 * digest is therefore the hash the history keeps for the `mapping` domain's
 * value. They name inputs within one page's life and across machines, so
 * capturing a provenance is asynchronous (`captureProvenance`); comparing two
 * (`staleReasons`) is not. The open cells are named by their cell-set digest
 * (`data/cell-identity.js`), which Python and R compute too.
 *
 * Which cells the view in focus shows changes in place (its transparency):
 * `visibleCellsNow` keeps one copy per state, taken when the set changes,
 * which is what a provenance digests and what an analysis scoped to the
 * visible cells keys what it keeps by (`revision`).
 *
 * @module analysis/shared/result-provenance
 */

import { formatCountOf } from '../../../utils/format-units.js';
import { hashValue, typedArrayDigest } from '../../history/value-pool.js';
import { isPlainRecord, requireExactKeys } from '../../../utils/exact-record.js';
import {
  getBasePageIdFromRestOf,
  getRestOfPageName,
  isRestOfPageId,
  parseSamplePageId,
} from './page-derivation-utils.js';

export const PROVENANCE_KEYS = Object.freeze(['cells', 'dataset', 'genesReadFor', 'mapping', 'options', 'pages', 'visible']);

const VISIBLE = new WeakMap();

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Which cells the view in focus shows now (its transparency, one byte a
 * cell) as an array never changed after it is returned, and a `revision`
 * that moves exactly when the set changes, not on every visibility pass (a
 * recolour runs one). Kept once per state, shared by every analysis of it:
 * a pass that left the set as it was costs one comparison, a change one copy.
 * Null without a transparency.
 *
 * @param {{categoryTransparency?: Uint8Array, _transparencyEpoch?: number}|null} state
 * @returns {{cells: Uint8Array, revision: number}|null}
 */
export function visibleCellsNow(state) {
  const transparency = state?.categoryTransparency;
  if (!(transparency instanceof Uint8Array)) return null;
  const epoch = state._transparencyEpoch ?? 0;
  let kept = VISIBLE.get(state);
  if (kept === undefined || kept.array !== transparency || kept.epoch !== epoch) {
    kept = kept !== undefined && sameBytes(kept.cells, transparency)
      ? { ...kept, array: transparency, epoch }
      : { array: transparency, epoch, cells: transparency.slice(), revision: (kept?.revision ?? 0) + 1 };
    VISIBLE.set(state, kept);
  }
  return { cells: kept.cells, revision: kept.revision };
}

/** The enabled groups' cells of a highlight page (each an array never changed once made). */
function enabledCellsOf(page) {
  return (page.highlightedGroups ?? [])
    .filter(group => group.enabled !== false && group.cellIndices instanceof Uint32Array)
    .map(group => group.cellIndices);
}

/**
 * The selected pages as provenance names them: a base page by its name, a
 * derived one ("Rest of X", a sample of X) by its name over its base's
 * cells.
 *
 * @param {{getHighlightPages: Function, getHighlightedCellCountForPage: Function}} state
 * @param {string[]} pageIds
 */
function describePages(state, pageIds) {
  const pages = state?.getHighlightPages?.() ?? [];
  const byId = new Map(pages.map(page => [page.id, page]));
  return pageIds.map(id => {
    const sample = parseSamplePageId(id);
    const baseId = isRestOfPageId(id) ? getBasePageIdFromRestOf(id) : sample?.baseId ?? id;
    const base = byId.get(baseId) ?? null;
    if (base === null) return { name: id, cells: null, digested: null };
    const name = isRestOfPageId(id)
      ? getRestOfPageName(base.name)
      : sample !== null ? `${base.name} (sample of ${formatCountOf(sample.m, 'cell')})` : base.name;
    // A derived page's cells follow its base's (and the open cells, recorded beside).
    const cells = enabledCellsOf(base);
    return id === baseId
      ? { name, cells: state?.getHighlightedCellCountForPage?.(base.id) ?? null, digested: cells }
      : { name, cells: null, digested: { derived: id, of: cells } };
  });
}

/**
 * What a result computed now would be computed on. The inputs are taken
 * when it is called (a change while their digests are computed is not in
 * it); the digests follow.
 *
 * @param {object} inputs
 * @param {object} inputs.state - The DataState
 * @param {{id: string|null, method: string|null, seed: number|null}|null} inputs.dataset - The open dataset
 * @param {string[]} inputs.pageIds - The selected pages
 * @param {object} inputs.options - The settings that decide the result
 * @param {{cells: number, of: number}|null} inputs.genesReadFor - The gene sample genes were read for
 * @param {Uint8Array|null} inputs.visible - The visible cells (`visibleCellsNow`), for an analysis of them
 * @returns {Promise<object>}
 */
export async function captureProvenance({ state, dataset, pageIds, options, genesReadFor, visible }) {
  const identity = state?.cellIdentity ?? null;
  const mapping = state?.getDataMapping?.() ?? null;
  const pages = describePages(state, pageIds);
  const taken = {
    dataset: dataset?.id ?? null,
    cells: identity === null ? null : {
      digest: identity.digest,
      open: identity.n,
      of: identity.nOriginal,
      method: identity.isSubset ? (dataset?.method ?? null) : null,
      seed: identity.isSubset ? (dataset?.seed ?? null) : null,
    },
    genesReadFor: genesReadFor === null ? null : { cells: genesReadFor.cells, of: genesReadFor.of },
    options: structuredClone(options),
  };
  const mappingTaken = mapping === null || typeof mapping !== 'object' ? null : structuredClone(mapping);
  return {
    ...taken,
    mapping: mappingTaken === null ? null : await hashValue(mappingTaken),
    pages: await Promise.all(pages.map(async ({ name, cells, digested }) => ({
      name, cells, digest: digested === null ? null : await hashValue(digested),
    }))),
    visible: visible === null ? null : await typedArrayDigest(visible),
  };
}

/** Canonical JSON: keys sorted, so equal values give equal text (an equality test, not a digest). */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (ArrayBuffer.isView(value)) return `[${Array.from(value).join(',')}]`;
  return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sameJson(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * What changed since `recorded`, one sentence each; empty when nothing did.
 * `current.genesReadFor` is the gene sample now (null: every open cell).
 *
 * @param {object} recorded
 * @param {object} current
 * @returns {string[]}
 */
export function staleReasons(recorded, current) {
  const reasons = [];
  if (recorded.dataset !== current.dataset) {
    reasons.push('This result was computed on another dataset.');
  }
  if (!sameJson(recorded.cells?.digest ?? null, current.cells?.digest ?? null)) {
    const then = recorded.cells;
    const now = current.cells;
    reasons.push(then !== null && now !== null && then.open !== now.open
      ? `The open cells changed since this result (${formatCountOf(then.open, 'cell')} then, ${formatCountOf(now.open, 'cell')} now).`
      : 'The open cells changed since this result.');
  }
  if (recorded.genesReadFor !== null && current.genesReadFor?.cells !== recorded.genesReadFor.cells) {
    reasons.push(`Genes are read for more cells since this result (${formatCountOf(recorded.genesReadFor.cells, 'cell')} then, ${
      current.genesReadFor === null ? 'every open cell' : formatCountOf(current.genesReadFor.cells, 'cell')} now).`);
  }
  if (recorded.mapping !== current.mapping) {
    reasons.push('The data mapping changed since this result.');
  }
  const thenPages = recorded.pages.map(page => page.name);
  const nowPages = current.pages.map(page => page.name);
  if (!sameJson(thenPages, nowPages)) {
    reasons.push(`The pages chosen changed since this result (${thenPages.join(', ') || 'none'} then, ${nowPages.join(', ') || 'none'} now).`);
  } else {
    for (let i = 0; i < recorded.pages.length; i++) {
      if (recorded.pages[i].digest !== current.pages[i].digest) {
        reasons.push(`The cells of ${recorded.pages[i].name} changed since this result.`);
      }
    }
  }
  if (recorded.visible !== current.visible) {
    reasons.push('The cells the view shows changed since this result.');
  }
  if (!sameJson(recorded.options, current.options)) {
    reasons.push('The settings changed since this result.');
  }
  return reasons;
}

/**
 * Check a provenance record read from a session or a history (untrusted):
 * every key, of its type.
 * @param {unknown} value
 * @param {string} [label]
 */
export function requireProvenance(value, label = 'Analysis result provenance') {
  requireExactKeys(value, PROVENANCE_KEYS, label);
  const { dataset, cells, genesReadFor, mapping, pages, visible, options } = value;
  const text = (item, what) => {
    if (item !== null && typeof item !== 'string') throw new TypeError(`${label} ${what} must be text or null`);
  };
  const count = (item, what) => {
    if (!Number.isSafeInteger(item) || item < 0) throw new TypeError(`${label} ${what} must be a count`);
  };
  text(dataset, 'dataset');
  text(mapping, 'mapping');
  text(visible, 'visible');
  if (cells !== null) {
    requireExactKeys(cells, ['digest', 'method', 'of', 'open', 'seed'], `${label} cells`);
    text(cells.digest, 'cells digest');
    text(cells.method, 'cells method');
    count(cells.open, 'open cells');
    count(cells.of, 'cells of');
    if (cells.seed !== null && !Number.isSafeInteger(cells.seed)) throw new TypeError(`${label} cells seed must be a whole number or null`);
  }
  if (genesReadFor !== null) {
    requireExactKeys(genesReadFor, ['cells', 'of'], `${label} genesReadFor`);
    count(genesReadFor.cells, 'genesReadFor cells');
    count(genesReadFor.of, 'genesReadFor of');
  }
  if (!Array.isArray(pages)) throw new TypeError(`${label} pages must be a list`);
  for (const page of pages) {
    requireExactKeys(page, ['cells', 'digest', 'name'], `${label} page`);
    if (typeof page.name !== 'string') throw new TypeError(`${label} page name must be text`);
    if (page.cells !== null) count(page.cells, 'page cells');
    text(page.digest, 'page digest');
  }
  if (!isPlainRecord(options)) throw new TypeError(`${label} options must be an object`);
  return value;
}

/** Provenance as an agent reads it (`analysis.list`, `analysis.result`): compact, snake_case. */
export function describeProvenance(provenance) {
  const cells = provenance.cells;
  return {
    dataset: provenance.dataset,
    cells: cells === null ? null : {
      open: cells.open, of: cells.of, share: cells.of === 0 ? 0 : cells.open / cells.of,
      method: cells.method, seed: cells.seed, digest: cells.digest,
    },
    genes_read_for: provenance.genesReadFor,
    mapping: provenance.mapping,
    pages: provenance.pages.map(page => ({ name: page.name, cells: page.cells })),
    visible_only: provenance.visible !== null,
  };
}
