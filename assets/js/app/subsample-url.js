/**
 * @fileoverview A subsample in a link: optional parameters beside the
 * dataset's, so a link opens the same cells for everyone who follows it.
 *
 *     ?data=cellxgene:…&cells=10%&sample=blocks&seed=7
 *     ?data=…&cells=250000&sample=stratified&by=cell_type&seed=0
 *     ?data=…&cells=100%                       (every cell, whatever fits)
 *
 * | parameter | value | default |
 * | --- | --- | --- |
 * | `cells` | a share (`10%`, `0.5%`, `100%`) or an exact count of at least 2 (`250000`; one cell has no coordinate variation to draw, `FEWEST_OPEN_CELLS`) | — (required by the others) |
 * | `sample` | `uniform`, `blocks`, `stratified`, `spatial` | the file's: `uniform` for a priority-ordered file, else `blocks` |
 * | `seed` | a whole number in [0, 2^32 − 1] | the file's priority seed, else `0` |
 * | `block` | `blocks`: cells per block | from the file's chunk layout |
 * | `by` | `stratified`: the categorical obs field | — (required) |
 * | `alloc` | `stratified`: `proportional` or `balanced` | `proportional` |
 * | `min` | `stratified`: cells first given to each category | `0` |
 * | `embedding` | `spatial`: the obsm key | the first 2-D embedding |
 * | `grid` | `spatial`: boxes per axis | `32` |
 *
 * The link carries the specification only, never the kept cells: the
 * specification gives the same cells everywhere (`data/subsample.js`), and
 * the cell-set digest the Session panel shows lets two people confirm it.
 * A link's subsample overrides fitting the dataset to the device; `cells=100%`
 * opens every cell. Parsing is strict: a malformed value, a parameter of
 * another method, or a method parameter without `cells` is refused by name.
 *
 * This is the one place a feature's state is in the address, by the owner's
 * decision (2026-10-27): the subsample is part of what a link shares.
 *
 * @module subsample-url
 */

import { FEWEST_OPEN_CELLS, FEWEST_OPEN_CELLS_REASON, STRATIFIED_ALLOCATIONS, SUBSAMPLE_METHODS } from '../data/subsample.js';
import { formatCountOf } from '../utils/format-units.js';

/** Every subsample parameter, in the order a link writes them. */
export const SUBSAMPLE_URL_PARAMETERS = Object.freeze(['cells', 'sample', 'seed', 'block', 'by', 'alloc', 'min', 'embedding', 'grid']);

const METHOD_PARAMETERS = Object.freeze({
  uniform: [],
  blocks: ['block'],
  stratified: ['by', 'alloc', 'min'],
  spatial: ['embedding', 'grid'],
});


function refuse(message) {
  return new Error(`The link's subsample: ${message}`);
}

function one(params, name) {
  const values = params.getAll(name);
  if (values.length === 0) return null;
  if (values.length > 1) throw refuse(`"${name}" is given ${formatCountOf(values.length, 'time')}.`);
  const value = values[0];
  if (value === '' || value !== value.trim()) throw refuse(`"${name}" must have a value.`);
  return value;
}

function wholeNumber(value, name, minimum) {
  if (!/^\d+$/.test(value)) throw refuse(`"${name}" must be a whole number; got "${value}".`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > 0xffffffff) {
    throw refuse(`"${name}" must be a whole number from ${minimum} to 4294967295; got "${value}".`);
  }
  return number;
}

/**
 * The cell subset request a link names (`anndata/subsample-plan.js`), or
 * null when it names none.
 *
 * @param {URLSearchParams} params
 * @returns {Object|null}
 */
export function parseSubsampleUrlParameters(params) {
  const present = SUBSAMPLE_URL_PARAMETERS.filter(name => params.has(name));
  if (present.length === 0) return null;
  const cells = one(params, 'cells');
  if (cells === null) throw refuse(`"${present[0]}" needs "cells" (a share such as 10%, or a count).`);
  let size;
  const share = /^(\d+(?:\.\d+)?)%$/.exec(cells);
  if (share !== null) {
    const percent = Number(share[1]);
    if (!(percent > 0 && percent <= 100)) throw refuse(`"cells" must be a share above 0% and at most 100%; got "${cells}".`);
    size = { percent: share[1] };
  } else if (/^\d+$/.test(cells)) {
    if (Number(cells) < FEWEST_OPEN_CELLS) {
      throw refuse(`"cells" must be at least ${FEWEST_OPEN_CELLS}: ${FEWEST_OPEN_CELLS_REASON}; got "${cells}".`);
    }
    size = { k: wholeNumber(cells, 'cells', FEWEST_OPEN_CELLS) };
  } else {
    throw refuse(`"cells" must be a share (10%) or a count of cells (250000); got "${cells}".`);
  }
  // No method or seed named: the file's default (`subsample-plan.js`,
  // `defaultSubsampleMethod`, and a priority-ordered file's own seed).
  const sample = one(params, 'sample');
  if (sample !== null && !SUBSAMPLE_METHODS.includes(sample)) {
    throw refuse(`"sample" must be ${SUBSAMPLE_METHODS.join(', ')}; got "${sample}".`);
  }
  for (const name of present) {
    if (['cells', 'sample', 'seed'].includes(name)) continue;
    if (sample === null) throw refuse(`"${name}" needs "sample", the method it is a parameter of.`);
    if (!METHOD_PARAMETERS[sample].includes(name)) throw refuse(`"${name}" is not a parameter of sample=${sample}.`);
  }
  if (size.percent !== undefined && Number(size.percent) === 100) {
    if (present.some(name => name !== 'cells')) throw refuse('"cells=100%" opens every cell; it takes no other parameter.');
    return Object.freeze({ mode: 'all' });
  }
  const request = { mode: 'subsample', ...(sample === null ? {} : { method: sample }), ...size, strict: true };
  const seed = one(params, 'seed');
  if (seed !== null) request.seed = wholeNumber(seed, 'seed', 0);
  if (sample === 'blocks' && params.has('block')) request.blockSize = wholeNumber(one(params, 'block'), 'block', 1);
  if (sample === 'stratified') {
    const by = one(params, 'by');
    if (by === null) throw refuse('sample=stratified needs "by", the categorical obs field.');
    request.field = by;
    const alloc = one(params, 'alloc');
    if (alloc !== null && !STRATIFIED_ALLOCATIONS.includes(alloc)) {
      throw refuse(`"alloc" must be ${STRATIFIED_ALLOCATIONS.join(' or ')}; got "${alloc}".`);
    }
    if (alloc !== null) request.allocation = alloc;
    if (params.has('min')) request.minPerCategory = wholeNumber(one(params, 'min'), 'min', 0);
  }
  if (sample === 'spatial') {
    const embedding = one(params, 'embedding');
    if (embedding !== null) request.embedding = embedding;
    if (params.has('grid')) request.gridSize = wholeNumber(one(params, 'grid'), 'grid', 1);
  }
  return Object.freeze(request);
}

/**
 * The parameters that reproduce a subsample exactly: its count, method,
 * seed and the method's own settings, never its cells.
 *
 * @param {Readonly<import('../data/subsample.js').SubsampleSpec>} spec
 * @returns {Array<[string, string]>}
 */
export function subsampleUrlEntries(spec) {
  const entries = [['cells', String(spec.k)], ['sample', spec.method], ['seed', String(spec.seed)]];
  if (spec.method === 'blocks') entries.push(['block', String(spec.blockSize)]);
  if (spec.method === 'stratified') {
    entries.push(['by', spec.field]);
    if (spec.allocation !== 'proportional') entries.push(['alloc', spec.allocation]);
    if (spec.minPerCategory !== 0) entries.push(['min', String(spec.minPerCategory)]);
  }
  if (spec.method === 'spatial') {
    entries.push(['embedding', spec.embedding]);
    entries.push(['grid', String(spec.gridSize)]);
  }
  return entries;
}

/**
 * A link to the page that opens `dataParams` (the dataset's own parameters,
 * `readDataSourceUrlParameters`) with the subsample `spec` (null: every cell).
 *
 * @param {string} href - The page's address
 * @param {URLSearchParams} dataParams
 * @param {Readonly<import('../data/subsample.js').SubsampleSpec>|null} spec
 * @returns {string}
 */
export function subsampleLink(href, dataParams, spec) {
  const url = new URL(href);
  url.search = '';
  for (const [name, value] of dataParams) url.searchParams.set(name, value);
  for (const [name, value] of spec === null ? [] : subsampleUrlEntries(spec)) url.searchParams.set(name, value);
  return url.toString();
}
