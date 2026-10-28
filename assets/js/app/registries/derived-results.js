/**
 * @fileoverview Gene sets and per-cell scores the viewer holds besides its
 * fields: the sets a notebook pushed (`setGeneSet`), the markers of the shown
 * marker genes result, the sets and scores of the shown gene signature
 * result.
 *
 * Each entry has an owner: `notebook` for a pushed set, which stays until it
 * is replaced or the dataset closes (and is saved in sessions), and
 * `markers` or `signature` for what an analysis result shows, which its
 * analysis replaces whole each time its result changes (`replaceOwned`) and
 * clears when the result goes. The viewer channel publishes every entry as a
 * result (`app/viewer-host-results.js`); the gene set editor offers the sets.
 *
 * Scores are in subset positions (the cells open now), as every per-cell
 * array inside the app is.
 *
 * @module registries/derived-results
 */

/** Who an entry belongs to. */
export const DERIVED_RESULT_OWNERS = Object.freeze(['notebook', 'markers', 'signature']);

/** The result origin (viewer protocol) of each owner. */
const ORIGIN_OF_OWNER = Object.freeze({
  notebook: 'notebook',
  markers: 'markers',
  signature: 'analysis',
});

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function requireOwner(owner) {
  if (!DERIVED_RESULT_OWNERS.includes(owner)) {
    throw new TypeError(`A derived result owner must be one of ${DERIVED_RESULT_OWNERS.join(', ')}`);
  }
  return owner;
}

/**
 * One gene set, checked and frozen: its genes as given, each once.
 *
 * @param {{name: string, description: string, genes: string[]}} set
 */
function freezeGeneSet({ name, description, genes }) {
  requireText(name, 'A gene set name');
  if (typeof description !== 'string') throw new TypeError('A gene set description must be text');
  if (!Array.isArray(genes)) throw new TypeError('A gene set must list its genes');
  const seen = new Set();
  for (const gene of genes) {
    requireText(gene, 'A gene name');
    if (seen.has(gene)) throw new TypeError(`Gene set "${name}" lists ${gene} twice`);
    seen.add(gene);
  }
  return Object.freeze({ name, description, genes: Object.freeze([...genes]) });
}

export class DerivedResultsRegistry {
  constructor() {
    /** @type {Map<string, {id: string, owner: string, origin: string, set: object}>} */
    this._geneSets = new Map();
    /** @type {Map<string, {id: string, owner: string, origin: string, key: string, cells: Uint32Array, values: Float32Array}>} */
    this._scores = new Map();
    this._listeners = new Set();
    this._nextNotebookSet = 1;
  }

  /** Run `listener` after every change; returns the unsubscribe function. */
  onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('A derived results listener must be a function');
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _changed() {
    for (const listener of [...this._listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[DerivedResults] listener failed:', error);
      }
    }
  }

  /** Every gene set, in the order they were made. */
  getGeneSets() {
    return [...this._geneSets.values()];
  }

  /** Every score, in the order they were made. */
  getScores() {
    return [...this._scores.values()];
  }

  /**
   * Add a notebook's gene set, or replace the one of the same name.
   *
   * @param {{name: string, description: string, genes: string[]}} set
   * @returns {{id: string, owner: 'notebook', origin: 'notebook', set: object}}
   */
  upsertNotebookGeneSet(set) {
    const frozen = freezeGeneSet(set);
    const existing = this.getGeneSets().find(entry => entry.owner === 'notebook' && entry.set.name === frozen.name);
    const id = existing?.id ?? `gene_set_${this._nextNotebookSet++}`;
    const entry = Object.freeze({ id, owner: 'notebook', origin: 'notebook', set: frozen });
    this._geneSets.set(id, entry);
    this._changed();
    return entry;
  }

  /**
   * Replace every entry `owner` holds with `geneSets` and `scores`: what an
   * analysis shows now (empty lists when it shows nothing).
   *
   * @param {'markers'|'signature'} owner
   * @param {{geneSets?: Array<{name: string, description: string, genes: string[]}>,
   *   scores?: Array<{key: string, cells: Uint32Array, values: Float32Array}>}} entries
   */
  replaceOwned(owner, { geneSets = [], scores = [] } = {}) {
    requireOwner(owner);
    if (owner === 'notebook') throw new TypeError('Notebook gene sets are replaced one at a time');
    const origin = ORIGIN_OF_OWNER[owner];
    for (const [id, entry] of this._geneSets) if (entry.owner === owner) this._geneSets.delete(id);
    for (const [id, entry] of this._scores) if (entry.owner === owner) this._scores.delete(id);
    for (const set of geneSets) {
      const frozen = freezeGeneSet(set);
      const id = `${owner}:${frozen.name}`;
      this._geneSets.set(id, Object.freeze({ id, owner, origin, set: frozen }));
    }
    for (const { key, cells, values } of scores) {
      requireText(key, 'A score key');
      if (!(cells instanceof Uint32Array) || !(values instanceof Float32Array) || cells.length !== values.length) {
        throw new TypeError(`Score "${key}" must hold one Float32Array value per cell of its Uint32Array cells`);
      }
      const id = `${owner}:${key}`;
      this._scores.set(id, Object.freeze({ id, owner, origin, key, cells, values }));
    }
    this._changed();
  }

  /**
   * The notebook's gene sets as a session stores them.
   * @returns {Array<{name: string, description: string, genes: string[]}>}
   */
  toSessionRecord() {
    return this.getGeneSets()
      .filter(entry => entry.owner === 'notebook')
      .map(({ set }) => ({ name: set.name, description: set.description, genes: [...set.genes] }));
  }

  /**
   * Replace the notebook's gene sets with a session's.
   * @param {Array<{name: string, description: string, genes: string[]}>} record
   */
  restoreSessionRecord(record) {
    if (!Array.isArray(record)) throw new TypeError('Saved gene sets must be a list');
    const sets = record.map(freezeGeneSet);
    const names = new Set();
    for (const set of sets) {
      if (names.has(set.name)) throw new TypeError(`Saved gene sets name "${set.name}" twice`);
      names.add(set.name);
    }
    for (const [id, entry] of this._geneSets) if (entry.owner === 'notebook') this._geneSets.delete(id);
    this._nextNotebookSet = 1;
    for (const set of sets) {
      const id = `gene_set_${this._nextNotebookSet++}`;
      this._geneSets.set(id, Object.freeze({ id, owner: 'notebook', origin: 'notebook', set }));
    }
    this._changed();
  }

  /**
   * The open cells were cut in place to the first `n`
   * (`state/managers/open-cells.js`): each score keeps its cells below `n`;
   * one left with none goes. Grown, a score's cells stay as they are.
   *
   * @param {number} n
   */
  keepCellsBelow(n) {
    let changed = false;
    for (const [id, entry] of [...this._scores]) {
      let kept = 0;
      for (let i = 0; i < entry.cells.length; i++) if (entry.cells[i] < n) kept++;
      if (kept === entry.cells.length) continue;
      changed = true;
      if (kept === 0) {
        this._scores.delete(id);
        continue;
      }
      const cells = new Uint32Array(kept);
      const values = new Float32Array(kept);
      let at = 0;
      for (let i = 0; i < entry.cells.length; i++) {
        if (entry.cells[i] < n) {
          cells[at] = entry.cells[i];
          values[at++] = entry.values[i];
        }
      }
      this._scores.set(id, Object.freeze({ ...entry, cells, values }));
    }
    if (changed) this._changed();
  }

  /**
   * The open cells put in another order: a score's cell `c` is cell
   * `positionOf[c]` now (its cells kept ascending).
   *
   * @param {Uint32Array} positionOf
   */
  moveCells(positionOf) {
    let changed = false;
    for (const [id, entry] of [...this._scores]) {
      const pairs = Array.from(entry.cells, (cell, i) => [positionOf[cell], entry.values[i]]).sort((a, b) => a[0] - b[0]);
      const cells = Uint32Array.from(pairs, ([cell]) => cell);
      const values = Float32Array.from(pairs, ([, value]) => value);
      this._scores.set(id, Object.freeze({ ...entry, cells, values }));
      changed = true;
    }
    if (changed) this._changed();
  }

  /**
   * Forget every score: its cells are positions of a reading no longer
   * shown (another dataset, or other cells of this one). Gene sets name
   * genes and stay.
   */
  clearScores() {
    if (this._scores.size === 0) return;
    this._scores.clear();
    this._changed();
  }

  /** Forget everything (the dataset closed or changed). */
  clear() {
    if (this._geneSets.size === 0 && this._scores.size === 0) return;
    this._geneSets.clear();
    this._scores.clear();
    this._nextNotebookSet = 1;
    this._changed();
  }
}
