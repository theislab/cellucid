#!/usr/bin/env node
/**
 * Write the golden history the web app, cellucid-python and cellucid-r all
 * read: one session file of format 4 in the History v2 shape
 * (`assets/js/app/session/README.md`, every record `app/history/model.js`'s),
 * and what reading it and applying it must give.
 *
 * - `tests/fixtures/history-golden.cellucid-session` and
 *   `tests/fixtures/history-golden.expected.json` (this repository);
 * - `tests/fixtures/history_golden/history_golden.cellucid-session` and
 *   `history_golden.expected.json` in cellucid-python;
 * - `tests/testthat/fixtures/history_golden/` in cellucid-r (same names), and
 *   the session again as `inst/extdata/history_golden.cellucid-session`, the
 *   example its help pages read (`system.file("extdata", …)`);
 *
 * byte for byte the same, each pinned by SHA-256 in its repository's tests.
 *
 * The history holds every kind of record the model has: three trackers (one
 * replayed from another, with its report and name mapping and each replayed
 * step's `replayOf`, its recording paused (`paused`); one in Recently deleted, named
 * like a tracker in use); four branches with a nested fork, one locked and
 * one archived; a notebook turn and an agent turn with its summary note, its
 * model, its conversation (kept with the tracker) and its message; a group
 * holding the notebook's whole turn, with its note; a squashed step holding
 * what changed while recording was paused (by the person and a notebook);
 * a squash in the middle of a branch (two steps merged into one that takes
 * the last one's id, with a step after it and a branch forking at it, the
 * first one's note and the last one's bookmark carried, journaled);
 * notes by the person and by the agent on a step, a branch, a group, a turn
 * and the tracker (its abstract); a bookmark; a deleted step whose dependent
 * step no longer applies (flagged, with the system's reason) and the journal
 * entry that can restore it, with the edits before it; a coalesced step; an
 * analysis result made stale by a later step. Every action step records the
 * version of its parameters (`v`). Values hold numbers JSON cannot hold (-0,
 * NaN), so a reader hashes them as the viewer does.
 *
 * The records are made with the model's own constructors and validated whole
 * (`validateSession`); domain values have the shapes the app's owners capture
 * (`app/state/domains/README.md`); labels and pseudocode lines are the
 * catalog's own (`describe`, `code`). The file is framed, encoded and hashed
 * as `app/session/history-file.js` frames them (`bundle/writer.js`, the
 * cell-set codec, `value-parts.js`, `value-pool.js`).
 *
 * `history-golden.expected.json` holds the reading (trackers, branches, the
 * step table, turns, notes, the journal, values at three steps, diffs, stale
 * results, the methods paragraph and the pseudocode) and the **apply
 * plans**: the dataset the plans are made against (its obs, var and
 * embedding, whose cell-order digest the fingerprint holds), and the rows of
 * applying the head, applying it again, applying the bookmark and applying
 * another branch's tip, one after another on the same object, with the
 * var columns each writes (`var_columns`: a gene set written or replaced,
 * `cellucid_gene_set__<name>`, one boolean per var row) and the
 * provenance the first records. Python, R and the browser's AnnData copy
 * (`app/history/exports/anndata-copy.js`) follow the same plan rules and
 * compare with these rows field by field. The rules are written out in
 * `cellucid-private/plans/history-v2.md` §7 ("H4 notes") and in the packages'
 * session docs.
 *
 *   node scripts/generate-history-golden.mjs           # write all three
 *   node scripts/generate-history-golden.mjs --check   # exit 1 when one differs
 *
 * `--check` compares what the files hold (the manifest and every chunk's
 * payload once inflated), not gzip's bytes, which another zlib may make
 * differently. The sibling repositories are found next to this one, or where
 * `CELLUCID_PYTHON_ROOT` and `CELLUCID_R_ROOT` say. After writing, pin the
 * printed digests in the three tests.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  createBy, createBranch, createGroup, createJournalEntry, createNote, createStep, createTracker, createTurn, emptyPatch,
  squashedLabel, validateSession,
} from '../assets/js/app/history/model.js';
import { hashValue } from '../assets/js/app/history/value-pool.js';
import { valuesAtStep, writeHistoryFile } from '../assets/js/app/session/history-file.js';
import { actionStamps, appStamp } from '../assets/js/app/session/app-stamp.js';
import { STATE_DEFAULTS, writeSharedHistory } from '../assets/js/app/session/share-scope.js';
import { cellOrderDigest } from '../assets/js/data/cell-order-digest.js';
import { validateDataMapping } from '../assets/js/data/data-mapping.js';
import { createActionCatalog } from '../assets/js/app/actions/catalog.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { DOMAIN_IDS, domainName } from '../assets/js/app/actions/domains.js';
import { createFieldOverlaysDomain } from '../assets/js/app/state/domains/field-overlays.js';
import { createHighlightsDomain } from '../assets/js/app/state/domains/highlights.js';
import { createGeneSetsDomain } from '../assets/js/app/state/domains/gene-sets.js';
import { createCellsDomain } from '../assets/js/app/state/domains/cells.js';
import { methodsParagraph } from '../assets/js/app/history/exports/methods.js';
import { historyPseudocode } from '../assets/js/app/history/exports/pseudocode.js';
import { renderActionCatalog } from './generate-action-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HISTORY_GOLDEN_SESSION_PATH = path.join(ROOT, 'tests', 'fixtures', 'history-golden.cellucid-session');
export const HISTORY_GOLDEN_EXPECTED_PATH = path.join(ROOT, 'tests', 'fixtures', 'history-golden.expected.json');
/** The golden's current state only (Share › Current state only), as the web app writes it. */
export const HISTORY_GOLDEN_STATE_PATH = path.join(ROOT, 'tests', 'fixtures', 'history-golden-state.cellucid-session');

/**
 * Where each package keeps its copies, relative to its repository; `example`:
 * a folder that ships the session with the package (its help pages' example).
 */
export const HISTORY_GOLDEN_MIRRORS = Object.freeze([
  Object.freeze({ repository: 'cellucid-python', env: 'CELLUCID_PYTHON_ROOT', dir: 'tests/fixtures/history_golden', example: null }),
  Object.freeze({ repository: 'cellucid-r', env: 'CELLUCID_R_ROOT', dir: 'tests/testthat/fixtures/history_golden', example: 'inst/extdata' }),
]);
export const PACKAGE_SESSION_NAME = 'history_golden.cellucid-session';
export const PACKAGE_EXPECTED_NAME = 'history_golden.expected.json';
export const PACKAGE_STATE_NAME = 'history_golden_state.cellucid-session';

const catalog = createActionCatalog(ACTION_DEFINITIONS);

// ---------------------------------------------------------------------------
// The dataset

const N = 600;
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const CELL_TYPES = ['B cell', 'T cell', 'NK cell'];
const cellTypeOf = i => (i < 200 ? 0 : i < 450 ? 1 : 2);
const LEIDEN = ['0', '1', '2', '3', '4', '5'];
const leidenOf = i => i % 6;
const GENES = ['CD3E', 'MS4A1', 'NKG7', 'LYZ'];
const DATASET_ID = 'history_golden';
const DATASET_NAME = 'History golden';
/** The embedding, as float32: what the cell-order digest is over. */
const UMAP = Float32Array.from(range(0, N).flatMap(i => [Math.cos(i / 10) * (1 + i / N), Math.sin(i / 10) * (1 + i / N)]));
const CELL_ORDER = { embedding: { key: 'X_umap', columns: [0, 1] }, dimension: 2, digest: cellOrderDigest(UMAP, 2) };

const mapping = validateDataMapping({
  kind: 'anndata',
  embeddings: { enabled: [{ key: 'X_umap', columns: [0, 1] }], defaults: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null } },
  knn: null, geneNames: 'index', expression: 'X', log1p: {}, highlyVariable: null, latent: null, vectorFields: [],
}, { label: 'golden mapping' });

// ---------------------------------------------------------------------------
// Ids, clock, authors

const T1 = 't-0b7c6f0e-3c1a-4a52-9d1e-5f2b8c4a7e10';
const T2 = 't-5d0e1c2b-7a4f-4e8b-9c3d-2f1a0b9c8d7e';
const T3 = 't-9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const START = 1_767_225_600_000; // 2026-01-01T00:00:00Z
let minute = 0;
const tick = () => START + 60_000 * minute++;

const user = createBy({ origin: 'user' });
const python = turn => createBy({ origin: 'host', host: 'python', turn });
const claude = turn => createBy({ origin: 'agent', agent: 'Claude', model: 'claude-sonnet-4-6', turn });
const replayBy = createBy({ origin: 'replay' });

// ---------------------------------------------------------------------------
// Domain values (the shapes `app/state/domains/README.md` gives)

const emptyOverlays = { renamedFields: [], renamedCategories: [], deletedFields: [], userFields: [] };
const ROOT_VALUES = {
  cells: { open: null, genes: null },
  mapping,
  // The values as stored, the default (`app/state/domains/expression.js`).
  expression: { normalize: false, log1p: false },
  'field-overlays': emptyOverlays,
  'gene-sets': { sets: [] },
  // The live view is named (`view.rename`): a named view's entry carries `name`, an unnamed one's has no key.
  views: { layout: 'single', focus: 0, liveHidden: false, camerasLinked: false, views: [{ embedding: { key: 'X_umap', columns: [0, 1] }, followsDefault: true, centroids: { points: false, labels: false }, name: 'Early' }] },
  'active-field': { views: [{ source: 'obs', key: 'cell_type' }] },
  filters: { views: [[]] },
  colors: { views: [[]] },
  visibility: { views: [new Uint32Array(0)] },
  highlights: { active: null, pages: [] },
  // Numbers JSON cannot hold: a reader hashes them as the viewer does.
  camera: { views: [{ navigationMode: 'orbit', orbit: { radius: 5, targetRadius: 5, theta: -0, phi: 0.5, target: [0, 0, 0] }, freefly: { position: [0, 0, 5], yaw: 0, pitch: 0 } }] },
  'camera-path': null,
  settings: { controls: { 'point-size': { kind: 'range', value: 3 }, 'gamma': { kind: 'range', value: Number.NaN } }, figureExport: null },
  analysis: { windows: [], docked: null },
  layout: { theme: 'light', sections: { state: true }, panels: [], analysis: { windows: [], sizes: null }, sidebar: { open: true, width: 320 } },
};

const doublets = Uint32Array.from(range(10, 50));
const gate = Uint32Array.from(range(300, 320));
const scoreCells = Uint32Array.from(range(0, N).filter(i => i % 3 !== 0));
const scoreValues = Float32Array.from(scoreCells, (cell, i) => (i % 7 === 0 ? Number.NaN : cell / 16 - 4));
const tCells = Uint32Array.from(range(0, N).filter(i => cellTypeOf(i) === 1));

const qcPage = groups => ({ id: 'page_1', name: 'QC', color: '#e41a1c', groups });
const doubletsGroup = { id: 'highlight_1', type: 'lasso', label: 'Doublets', enabled: true, cells: doublets };
const gateGroup = enabled => ({ id: 'highlight_3', type: 'lasso', label: 'Gate', enabled, cells: gate });

const scoreField = {
  id: 'user_obs_value_1', source: 'obs', kind: 'continuous', key: 'score', deleted: false, purged: false,
  createdAt: START + 180_000, sourceField: null, operation: { type: 'notebook-push' },
  values: { cells: scoreCells, values: scoreValues },
};
// cell_type with B cell merged into T cell (shown labels, NK renamed NK).
const mergedCategories = ['T cell', 'NK'];
const mergedField = {
  id: 'user_cat_1', source: 'obs', kind: 'category', key: 'cell_type (merged)', deleted: false, purged: false,
  createdAt: START + 720_000,
  sourceField: { kind: 'categorical-obs', sourceKey: 'cell_type', sourceIndex: 0 },
  operation: {
    type: 'merge-categories', fromCategoryIndex: 0, toCategoryIndex: 1,
    fromCategoryLabel: 'B cell', toCategoryLabel: 'T cell', mergedCategoryLabel: 'T cell',
  },
  categories: mergedCategories,
  codes: { cells: null, values: Uint8Array.from(range(0, N), i => (cellTypeOf(i) === 2 ? 1 : 0)) },
  sourcePages: [], overlapStrategy: 'first', overlapLabel: null, intersectionLabels: null, uncoveredLabel: null, palette: null,
};
const nkRename = { source: 'obs', field: 'cell_type', category: 'NK cell', name: 'NK' };
const markersResult = {
  kind: 'markers', version: 1,
  payload: { groupBy: 'cell_type', genes: ['CD3E', 'NKG7'], scores: Float32Array.of(2.5, 1.25) },
};

// ---------------------------------------------------------------------------
// The history, step by step

/** Every value of every step, by hash; and each step's state. */
const pool = new Map();
async function hashed(value) {
  const hash = await hashValue(value);
  if (!pool.has(hash)) pool.set(hash, value);
  return hash;
}

/** The state (domain → value) after each step of a tracker, by step id. */
const statesOf = new Map();

async function rootHashes() {
  const out = {};
  for (const id of DOMAIN_IDS) out[id] = await hashed(ROOT_VALUES[id]);
  return out;
}

/**
 * Record one step of a tracker: its action (labels and code from the
 * catalog), the domains it changes (`changes`: domain → value; only those
 * that differ are its touches), who took it and when.
 */
async function recordStep(tracker, { id, parent, branch, type, params, by, changes, outcome = null, at = tick(), until = at, merged = 1, ms = 12.5, reads = {}, replayOf = null, coalesceKey = null }) {
  const definition = catalog.get(type);
  const before = statesOf.get(`${tracker.id}/${parent}`);
  const after = { ...before };
  const touches = [];
  const beforeHashes = {};
  const afterHashes = {};
  for (const domain of DOMAIN_IDS) {
    if (!Object.hasOwn(changes, domain)) continue;
    const was = await hashed(before[domain]);
    const now = await hashed(changes[domain]);
    if (was === now) continue;
    touches.push(domain);
    beforeHashes[domain] = was;
    afterHashes[domain] = now;
    after[domain] = changes[domain];
  }
  statesOf.set(`${tracker.id}/${id}`, after);
  const step = createStep({
    id, parent, branch, type, params, v: definition.version, code: definition.code(params), label: definition.describe(params, outcome), by,
    at, until, merged, ms, touches, before: beforeHashes, after: afterHashes, reads, outcome, coalesceKey, replayOf,
  });
  const parentStep = tracker.steps.find(candidate => candidate.id === parent);
  parentStep.children.push(id);
  tracker.steps.push(step);
  return step;
}

/**
 * Record a squashed step (no action of its own): the net change `changes`
 * makes from its parent's state, labeled as the history labels one.
 */
async function recordSquashed(tracker, { id, parent, branch, squashed, changes, at, ms = null, by = user }) {
  const before = statesOf.get(`${tracker.id}/${parent}`);
  const after = { ...before };
  const touches = [];
  const beforeHashes = {};
  const afterHashes = {};
  for (const domain of DOMAIN_IDS) {
    if (!Object.hasOwn(changes, domain)) continue;
    beforeHashes[domain] = await hashed(before[domain]);
    afterHashes[domain] = await hashed(changes[domain]);
    if (beforeHashes[domain] === afterHashes[domain]) throw new Error(`The squashed step ${id} changes ${domain} to what it was`);
    touches.push(domain);
    after[domain] = changes[domain];
  }
  statesOf.set(`${tracker.id}/${id}`, after);
  const step = createStep({
    id, parent, branch, kind: 'squashed', label: squashedLabel({ ...squashed, domains: touches.map(domainName) }), by, at, ms,
    touches, before: beforeHashes, after: afterHashes, squashed,
  });
  tracker.steps.find(candidate => candidate.id === parent).children.push(id);
  tracker.steps.push(step);
  return step;
}

/** What a squash of the steps after `from` up to `to` changes: each domain that differs, before and after. */
async function squashedChange(tracker, from, to) {
  const before = statesOf.get(`${tracker.id}/${from}`);
  const after = statesOf.get(`${tracker.id}/${to}`);
  const touches = [];
  const beforeHashes = {};
  const afterHashes = {};
  for (const domain of DOMAIN_IDS) {
    const was = await hashed(before[domain]);
    const now = await hashed(after[domain]);
    if (was === now) continue;
    touches.push(domain);
    beforeHashes[domain] = was;
    afterHashes[domain] = now;
  }
  return { touches, before: beforeHashes, after: afterHashes };
}

/** The value hash of each read input at a step (what `step.reads` records). */
async function readsAt(tracker, stepId, domains) {
  const state = statesOf.get(`${tracker.id}/${stepId}`);
  const out = {};
  for (const domain of domains) out[domain] = await hashed(state[domain]);
  return out;
}

function stepOf(tracker, id) {
  return tracker.steps.find(step => step.id === id);
}

function branchOf(tracker, id) {
  return tracker.branches.find(branch => branch.id === id);
}

function clone(record) {
  return structuredClone(record);
}

async function makeAnnotation() {
  const createdAt = tick();
  const roots = await rootHashes();
  const tracker = createTracker({
    id: T1, name: 'Annotation', dataset: { id: DATASET_ID, name: DATASET_NAME, cellOrder: CELL_ORDER }, createdAt, by: user,
    rootValues: roots,
  });
  statesOf.set(`${T1}/s0`, { ...ROOT_VALUES });
  const journal = [];

  // Main: a rename, a notebook turn (a highlight, a pushed column), an agent turn.
  const s1 = await recordStep(tracker, {
    id: 's1', parent: 's0', branch: 'b0', type: 'category.rename', by: user,
    params: { field: { source: 'obs', key: 'cell_type' }, category: 'NK cell', name: 'NK' },
    changes: { 'field-overlays': { ...emptyOverlays, renamedCategories: [nkRename] } },
    outcome: { renamed: 1 },
  });
  const overlaysS1 = statesOf.get(`${T1}/s1`)['field-overlays'];
  const s2 = await recordStep(tracker, {
    id: 's2', parent: 's1', branch: 'b0', type: 'highlight.cells', by: python('py-1'),
    params: { cells: doublets, label: 'Doublets', page: 'QC', color: '#e41a1c' },
    changes: { highlights: { active: 'page_1', pages: [qcPage([doubletsGroup])] } },
    outcome: { group: 'Doublets', page: 'QC', cells: doublets.length },
  });
  const s3 = await recordStep(tracker, {
    id: 's3', parent: 's2', branch: 'b0', type: 'field.push', by: python('py-1'),
    params: { key: 'score', kind: 'continuous', categories: null, n_obs: N, cells: scoreCells, values: scoreValues },
    changes: { 'field-overlays': { ...overlaysS1, userFields: [scoreField] } },
    outcome: { name: 'score', kind: 'continuous', id: 'user_obs_value_1' },
  });
  const overlaysS3 = statesOf.get(`${T1}/s3`)['field-overlays'];
  const s4 = await recordStep(tracker, {
    id: 's4', parent: 's3', branch: 'b0', type: 'analysis.run', by: claude('claude-1'), ms: 4200,
    params: { analysis: 'markers' },
    changes: { analysis: { windows: [], docked: { openMode: 'markers', modes: { markers: { settings: { groupBy: 'cell_type', topN: 5 }, result: markersResult } } } } },
    reads: await readsAt(tracker, 's3', catalog.get('analysis.run').reads),
    outcome: { analysis: 'markers' },
  });
  const s5 = await recordStep(tracker, {
    id: 's5', parent: 's4', branch: 'b0', type: 'gene-set.save', by: claude('claude-1'),
    params: { name: 'T cell markers', description: 'From Claude', genes: ['CD3E', 'NKG7'] },
    changes: { 'gene-sets': { sets: [{ name: 'T cell markers', description: 'From Claude', genes: ['CD3E', 'NKG7'] }] } },
    outcome: { name: 'T cell markers', id: 'gene_set_1' },
  });
  const s6 = await recordStep(tracker, {
    id: 's6', parent: 's5', branch: 'b0', type: 'color.by', by: claude('claude-1'),
    params: { field: { source: 'var', key: 'CD3E' } },
    changes: { 'active-field': { views: [{ source: 'var', key: 'CD3E' }] } },
  });
  // A branch from the doublets: the leiden field renamed, the T cells highlighted.
  const s7 = await recordStep(tracker, {
    id: 's7', parent: 's2', branch: 'b1', type: 'field.rename', by: user,
    params: { field: { source: 'obs', key: 'leiden' }, name: 'cluster' },
    changes: { 'field-overlays': { ...overlaysS1, renamedFields: [{ source: 'obs', key: 'leiden', name: 'cluster' }] } },
  });
  const overlaysS7 = statesOf.get(`${T1}/s7`)['field-overlays'];
  const s8 = await recordStep(tracker, {
    id: 's8', parent: 's7', branch: 'b1', type: 'highlight.category', by: user,
    params: { field: { source: 'obs', key: 'cell_type' }, categories: ['T cell'], page: 'Types', color: '#2563eb' },
    changes: {
      highlights: {
        active: 'page_2',
        pages: [qcPage([doubletsGroup]), {
          id: 'page_2', name: 'Types', color: '#2563eb',
          groups: [{ id: 'highlight_2', type: 'category', label: 'cell_type: T cell', enabled: true, cells: tCells, field: { source: 'obs', key: 'cell_type' }, category: 'T cell' }],
        }],
      },
    },
    outcome: { page: 'Types', groups: ['cell_type: T cell'], categories: ['T cell'], cells: tCells.length, updated: 0 },
  });
  // A nested fork from the rename: a cluster renamed (then locked).
  const s9 = await recordStep(tracker, {
    id: 's9', parent: 's7', branch: 'b2', type: 'category.rename', by: user,
    params: { field: { source: 'obs', key: 'leiden' }, category: '0', name: 'Zero' },
    changes: { 'field-overlays': { ...overlaysS7, renamedCategories: [nkRename, { source: 'obs', field: 'leiden', category: '0', name: 'Zero' }] } },
    outcome: { renamed: 1 },
  });
  // A scratch branch from the gene set: a camera gesture of three changes (then archived).
  const cameraAt = tick();
  const s10 = await recordStep(tracker, {
    id: 's10', parent: 's5', branch: 'b3', type: 'camera.set', by: user, at: cameraAt, until: cameraAt + 2000, merged: 3, ms: null,
    params: {
      view: 'View 1',
      camera: { navigationMode: 'orbit', orbit: { radius: 3, targetRadius: 3, theta: 0.25, phi: 0.5, target: [0, 0, 0] }, freefly: { position: [0, 0, 5], yaw: 0, pitch: 0 } },
    },
    changes: { camera: { views: [{ navigationMode: 'orbit', orbit: { radius: 3, targetRadius: 3, theta: 0.25, phi: 0.5, target: [0, 0, 0] }, freefly: { position: [0, 0, 5], yaw: 0, pitch: 0 } }] } },
    coalesceKey: 'camera:View 1',
  });
  // Back on Main: a gate highlighted and hidden, then a merge.
  const s11 = await recordStep(tracker, {
    id: 's11', parent: 's6', branch: 'b0', type: 'highlight.cells', by: user,
    params: { cells: gate, label: 'Gate', page: 'QC', color: '#e41a1c' },
    changes: { highlights: { active: 'page_1', pages: [qcPage([doubletsGroup, gateGroup(true)])] } },
    outcome: { group: 'Gate', page: 'QC', cells: gate.length },
  });
  const s12 = await recordStep(tracker, {
    id: 's12', parent: 's11', branch: 'b0', type: 'highlight.group.toggle', by: user,
    params: { group: 'Gate', enabled: false, page: 'QC' },
    changes: { highlights: { active: 'page_1', pages: [qcPage([doubletsGroup, gateGroup(false)])] } },
  });
  const s13 = await recordStep(tracker, {
    id: 's13', parent: 's12', branch: 'b0', type: 'category.merge', by: user,
    params: { field: { source: 'obs', key: 'cell_type' }, category: 'B cell', into: 'T cell' },
    changes: { 'field-overlays': { ...overlaysS3, userFields: [scoreField, mergedField] } },
    outcome: { name: 'cell_type (merged)', merged: 'T cell', in_place: false },
  });
  // Later, recording paused on the scratch branch: the person changed a color
  // map and a notebook a point size; resuming kept them as one squashed step.
  const s14 = await recordSquashed(tracker, {
    id: 's14', parent: 's10', branch: 'b3', at: tick(), ms: null,
    squashed: { cause: 'paused', count: null, by: [user, createBy({ origin: 'host', host: 'python' })], carried: { notes: [], bookmarks: [] } },
    changes: {
      colors: { views: [[{ field: { source: 'var', key: 'CD3E' }, colormap: 'magma' }]] },
      settings: { ...ROOT_VALUES.settings, controls: { ...ROOT_VALUES.settings.controls, 'point-size': { kind: 'range', value: 5 } } },
    },
  });
  // Then, recorded again: three steps on the scratch branch, and a branch
  // forking at the second (s16), which the squash at the end merges with
  // the first (s15) into one step with s16's id.
  const orbit = theta => ({ navigationMode: 'orbit', orbit: { radius: 3, targetRadius: 3, theta, phi: 0.5, target: [0, 0, 0] }, freefly: { position: [0, 0, 5], yaw: 0, pitch: 0 } });
  const s15 = await recordStep(tracker, {
    id: 's15', parent: 's14', branch: 'b3', type: 'color.by', by: user, params: { field: { source: 'obs', key: 'leiden' } },
    changes: { 'active-field': { views: [{ source: 'obs', key: 'leiden' }] } },
  });
  await recordStep(tracker, {
    id: 's16', parent: 's15', branch: 'b3', type: 'camera.set', by: user, ms: null,
    params: { view: 'View 1', camera: orbit(0.5) }, changes: { camera: { views: [orbit(0.5)] } }, coalesceKey: 'camera:View 1',
  });
  await recordStep(tracker, {
    id: 's17', parent: 's16', branch: 'b3', type: 'camera.set', by: user, ms: null,
    params: { view: 'View 1', camera: orbit(0.75) }, changes: { camera: { views: [orbit(0.75)] } }, coalesceKey: 'camera:View 1',
  });
  const s18 = await recordStep(tracker, {
    id: 's18', parent: 's16', branch: 'b4', type: 'color.by', by: user, params: { field: { source: 'var', key: 'NKG7' } },
    changes: { 'active-field': { views: [{ source: 'var', key: 'NKG7' }] } },
  });
  tracker.nextStep = 19;

  // The branches, their notes and flags.
  tracker.branches = [
    { ...tracker.branches[0], tip: 's13' },
    createBranch({ id: 'b1', name: 'Without score', base: 's2', tip: 's8', createdAt: s7.at, by: user }),
    createBranch({ id: 'b2', name: 'Clusters', base: 's7', tip: 's9', createdAt: s9.at, by: user }),
    createBranch({ id: 'b3', name: 'Scratch', base: 's5', tip: 's17', createdAt: s10.at, by: user }),
    createBranch({ id: 'b4', name: 'Tidy fork', base: 's16', tip: s18.id, createdAt: s18.at, by: user }),
  ];
  tracker.nextBranch = 5;
  let noteNumber = 0;
  let journalNumber = 0;
  const note = (text, by, extra = {}) => createNote({ id: `n${noteNumber++}`, text, by, at: tick(), ...extra });
  const entry = (op, label, before, after, by = user) => {
    const made = createJournalEntry({ id: `j${journalNumber++}`, op, at: tick(), by, label, before, after });
    journal.push(made);
    return made;
  };

  // The tracker's abstract (journaled, as every note is).
  const abstract = note('Annotation of the golden sample: *T cells* first, then the `leiden` clusters.', user);
  entry('note.add', 'Added a note on the tracker', { ...emptyPatch(), tracker: { notes: [] } }, { ...emptyPatch(), tracker: { notes: [abstract] } });
  tracker.notes = [abstract];
  // A step note by the person, one by the agent (with a bookmark on its step), a branch note.
  stepOf(tracker, 's1').notes.push(note('NK is the name the paper uses.', user));
  const agentNote = note('Top hits match the paper.', claude('claude-1'));
  stepOf(tracker, 's5').notes.push(agentNote);
  const s5Before = clone(stepOf(tracker, 's5'));
  stepOf(tracker, 's5').bookmark = 'Markers saved';
  entry('bookmark.set', 'Bookmarked step 5 "Markers saved"', { ...emptyPatch(), steps: [s5Before] }, { ...emptyPatch(), steps: [clone(stepOf(tracker, 's5'))] });
  // The notebook's turn (s2, s3) grouped as "QC", with a note on the group.
  const qc = createGroup({ id: 'g0', name: 'QC', createdAt: tick(), by: user });
  for (const id of ['s2', 's3']) stepOf(tracker, id).group = qc.id;
  // Journaled as which steps the group holds, never as its steps.
  entry('group.create', 'Grouped steps 2 to 3 as "QC"',
    emptyPatch(),
    { ...emptyPatch(), groups: [clone(qc)], memberships: [{ group: qc.id, from: 's2', to: 's3' }] });
  qc.notes.push(note('Doublets marked and the score pushed from the notebook.', user));
  tracker.groups = [qc];
  tracker.nextGroup = 1;
  branchOf(tracker, 'b1').notes.push(note('Without the score the clusters read better.', user));
  // Lock the nested branch, archive the scratch one.
  const b2Before = clone(branchOf(tracker, 'b2'));
  branchOf(tracker, 'b2').locked = true;
  entry('branch.lock', 'Locked branch "Clusters"', { ...emptyPatch(), branches: [b2Before] }, { ...emptyPatch(), branches: [clone(branchOf(tracker, 'b2'))] });
  const b3Before = clone(branchOf(tracker, 'b3'));
  branchOf(tracker, 'b3').archived = true;
  entry('branch.archive', 'Archived branch "Scratch"', { ...emptyPatch(), branches: [b3Before] }, { ...emptyPatch(), branches: [clone(branchOf(tracker, 'b3'))] });

  // The turns: the notebook's, and the agent's with its summary.
  tracker.turns = [
    { ...createTurn({ id: 'py-1', by: python('py-1'), label: 'QC', startedAt: s2.at, branch: 'b0' }), endedAt: s3.at },
    {
      ...createTurn({ id: 'claude-1', by: claude('claude-1'), label: 'Find markers', conversation: 'conv-1', message: 'msg-2', startedAt: s4.at, branch: 'b0' }),
      endedAt: s6.at,
      notes: [note('Ran markers on cell_type, kept the T cell markers and colored by CD3E.', claude('claude-1'))],
    },
  ];
  tracker.chats = [['conv-1', {
    messages: [
      { id: 'msg-1', role: 'user', text: 'Find the T cell markers and show the top one.' },
      { id: 'msg-2', role: 'assistant', text: 'Ran markers on cell_type, kept the T cell markers and colored by CD3E.', turn: 'claude-1' },
    ],
  }]];

  // Delete the gate (s11): its toggle (s12) no longer applies and keeps its
  // parent's values, flagged; the merge (s13) neither read nor changed the
  // highlights and is kept as it was.
  const s6Before = clone(stepOf(tracker, 's6'));
  const s11Before = clone(stepOf(tracker, 's11'));
  const s12Before = clone(stepOf(tracker, 's12'));
  const s6After = stepOf(tracker, 's6');
  s6After.children = ['s12'];
  const flagged = stepOf(tracker, 's12');
  flagged.parent = 's6';
  flagged.status = 'unapplicable';
  flagged.reason = 'There is no highlight "Gate" on page "QC"; its highlights are "Doublets".';
  const atS6 = await hashed(statesOf.get(`${T1}/s6`).highlights);
  flagged.before = { highlights: atS6 };
  flagged.after = { highlights: atS6 };
  statesOf.set(`${T1}/s12`, statesOf.get(`${T1}/s6`));
  statesOf.set(`${T1}/s13`, { ...statesOf.get(`${T1}/s13`), highlights: statesOf.get(`${T1}/s6`).highlights });
  tracker.steps = tracker.steps.filter(step => step.id !== 's11');
  entry('step.delete', 'Deleted step 11 "Highlighted 20 cells as "Gate" on page "QC""',
    { ...emptyPatch(), steps: [s6Before, s11Before, s12Before] },
    { ...emptyPatch(), steps: [clone(s6After), clone(flagged)] });
  // A note on s15 and a bookmark on s16; then s15 and s16 squashed in the
  // middle of the scratch branch: the squashed step takes s16's id, so s17
  // and the branch forking at s16 keep their parent; it carries the note and
  // the bookmark.
  stepOf(tracker, 's15').notes.push(note('Leiden, before tidying.', user));
  stepOf(tracker, 's16').bookmark = 'Before tidying';
  const replaced = ['s14', 's15', 's16'].map(id => clone(stepOf(tracker, id)));
  const s16Old = stepOf(tracker, 's16');
  const squashedValues = await squashedChange(tracker, 's14', 's16');
  const squashed = createStep({
    id: 's16', parent: 's14', branch: 'b3', kind: 'squashed',
    label: squashedLabel({ cause: 'steps', count: 2, domains: squashedValues.touches.map(domainName) }),
    by: user, at: s15.at, until: s16Old.until, merged: 2, ms: null, ...squashedValues,
    squashed: { cause: 'steps', count: 2, by: [user], carried: { notes: stepOf(tracker, 's15').notes.map(item => item.id), bookmarks: ['Before tidying'] } },
    notes: stepOf(tracker, 's15').notes,
  });
  squashed.children = [...s16Old.children];
  stepOf(tracker, 's14').children = ['s16'];
  tracker.steps = tracker.steps.filter(step => step.id !== 's15' && step.id !== 's16');
  tracker.steps.splice(tracker.steps.findIndex(step => step.id === 's17'), 0, squashed);
  entry('squash', squashed.label,
    { ...emptyPatch(), steps: replaced },
    { ...emptyPatch(), steps: [clone(stepOf(tracker, 's14')), clone(squashed)] });
  tracker.journal = journal;
  tracker.nextNote = noteNumber;
  tracker.nextJournal = journalNumber;
  tracker.headId = 's13';
  return tracker;
}

async function makeReplay(source) {
  const createdAt = tick();
  const roots = await rootHashes();
  const s1 = stepOf(source, 's1');
  const s2 = stepOf(source, 's2');
  const s3 = stepOf(source, 's3');
  const tracker = createTracker({
    id: T2, name: 'Annotation (replay)', dataset: { id: DATASET_ID, name: DATASET_NAME, cellOrder: CELL_ORDER }, createdAt, by: user,
    start: {
      kind: 'replay',
      from: {
        dataset: { id: DATASET_ID, name: DATASET_NAME }, tracker: { id: T1, name: 'Annotation' },
        branch: { id: 'b0', name: 'Main' }, step: 's3', file: null, saved: 'state-1',
      },
      report: [
        { source: 's1', label: s1.label, outcome: 'applied', step: 's1', reason: null, missing: null },
        { source: 's2', label: s2.label, outcome: 'applied', step: 's2', reason: null, missing: null },
        { source: 's3', label: s3.label, outcome: 'unmatched', step: null, reason: 'Recorded with another version (0.9.5): cannot be replayed here.', missing: null },
      ],
      mapping: { fields: [], categories: [], genes: [{ from: 'Cd3e', to: 'CD3E' }] },
    },
    rootValues: roots,
  });
  statesOf.set(`${T2}/s0`, { ...ROOT_VALUES });
  const replayOf = step => ({ tracker: T1, step, dataset: { id: DATASET_ID, name: DATASET_NAME } });
  await recordStep(tracker, {
    id: 's1', parent: 's0', branch: 'b0', type: 'category.rename', by: replayBy, params: s1.params,
    changes: { 'field-overlays': { ...emptyOverlays, renamedCategories: [nkRename] } }, outcome: { renamed: 1 }, replayOf: replayOf('s1'),
  });
  await recordStep(tracker, {
    id: 's2', parent: 's1', branch: 'b0', type: 'highlight.cells', by: replayBy, params: s2.params,
    changes: { highlights: { active: 'page_1', pages: [qcPage([doubletsGroup])] } },
    outcome: { group: 'Doublets', page: 'QC', cells: doublets.length }, replayOf: replayOf('s2'),
  });
  tracker.branches = [{ ...tracker.branches[0], tip: 's2' }];
  tracker.headId = 's2';
  tracker.nextStep = 3;
  // Its recording paused since, by the person: what is shown matches its
  // head, and a file squashes any draft first, so it keeps none.
  tracker.paused = { at: tick(), by: [user], draft: null };
  return tracker;
}

async function makeRemoved() {
  const createdAt = tick();
  const roots = await rootHashes();
  const tracker = createTracker({
    id: T3, name: 'Annotation', dataset: { id: DATASET_ID, name: DATASET_NAME, cellOrder: CELL_ORDER }, createdAt, by: user,
    rootValues: roots,
  });
  statesOf.set(`${T3}/s0`, { ...ROOT_VALUES });
  await recordStep(tracker, {
    id: 's1', parent: 's0', branch: 'b0', type: 'color.by', by: user, params: { field: { source: 'obs', key: 'leiden' } },
    changes: { 'active-field': { views: [{ source: 'obs', key: 'leiden' }] } },
  });
  tracker.branches = [{ ...tracker.branches[0], tip: 's1' }];
  tracker.headId = 's1';
  tracker.nextStep = 2;
  const removal = { at: tick(), by: user };
  tracker.removed = removal;
  tracker.journal = [createJournalEntry({
    id: 'j0', op: 'tracker.remove', at: removal.at, by: user, label: 'Removed the tracker "Annotation"',
    before: { ...emptyPatch(), tracker: { removed: null } }, after: { ...emptyPatch(), tracker: { removed: removal } },
  })];
  tracker.nextJournal = 1;
  return tracker;
}

// ---------------------------------------------------------------------------
// The file, written by the app's own writer

/** The page chrome the golden file carries outside its history. */
export const GOLDEN_CHROME = Object.freeze({ pressed: Object.freeze({ 'highlight-mode': 'highlight-mode-lasso' }) });

async function writeSession(trackers, { activeTracker, header, app, actions, scope }) {
  const referenced = new Set();
  for (const tracker of trackers) {
    const steps = [...tracker.steps, ...tracker.journal.flatMap(entry => (entry.purged ? [] : [...entry.before.steps, ...entry.after.steps]))];
    for (const step of steps) for (const hash of [...Object.values(step.before), ...Object.values(step.after)]) referenced.add(hash);
  }
  const blob = await writeHistoryFile({
    header, app, actions, scope, history: { activeTracker, trackers }, valueOf: hash => pool.get(hash),
    // The page chrome sessions carry outside the history: the selection tool pressed (CEL-0249).
    chrome: GOLDEN_CHROME,
  });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), valueCount: referenced.size };
}

// ---------------------------------------------------------------------------
// The reading, as every reader must give it

const STEP_COLUMNS = Object.freeze([
  'id', 'branch', 'parent', 'kind', 'type', 'v', 'label', 'code', 'origin', 'agent', 'model', 'host', 'turn', 'at', 'status',
  'stale', 'bookmark', 'group', 'n_notes',
]);

function pathTo(tracker, stepId) {
  const byId = new Map(tracker.steps.map(step => [step.id, step]));
  const path = [];
  for (let step = byId.get(stepId); step !== undefined; step = step.parent === null ? undefined : byId.get(step.parent)) path.push(step);
  return path.reverse();
}

/**
 * Stale results at the tracker's head (`history-v2.md` §3.4): a step on the
 * head's path whose output is still current at the head, one of whose read
 * domains differs there, with the first step after it on the path that
 * changed that domain as the cause.
 */
function staleAt(tracker) {
  const path = pathTo(tracker, tracker.headId);
  const head = valuesAtStep(tracker.steps, tracker.headId);
  const out = [];
  path.forEach((step, index) => {
    const read = Object.entries(step.reads).filter(([domain]) => domain !== 'history');
    if (read.length === 0 || step.status !== 'applied') return;
    if (!step.touches.every(domain => head[domain] === step.after[domain])) return;
    const changed = read.filter(([domain, hash]) => head[domain] !== hash).map(([domain]) => domain);
    if (changed.length === 0) return;
    const cause = path.slice(index + 1).find(later => later.touches.some(domain => changed.includes(domain))) ?? null;
    out.push({
      step: step.id,
      cause: cause === null ? null : cause.id,
      domains: DOMAIN_IDS.filter(domain => changed.includes(domain)),
    });
  });
  return out;
}

function stepRow(tracker, step, stale) {
  return [
    step.id, step.branch, step.parent, step.kind, step.type, step.v, step.label, step.code, step.by.origin, step.by.agent, step.by.model,
    step.by.host, step.by.turn, step.at, step.status, stale.has(step.id), step.bookmark, step.group, step.notes.length,
  ];
}

function readingOf(tracker) {
  const stale = new Set(staleAt(tracker).map(entry => entry.step));
  const tips = new Set(tracker.branches.map(branch => branch.tip));
  return {
    id: tracker.id,
    name: tracker.name,
    removed: tracker.removed !== null,
    start: tracker.start.kind,
    head: tracker.headId,
    active_branch: tracker.activeBranch,
    main_branch: tracker.mainBranch,
    paused: tracker.paused === null ? null : { at: tracker.paused.at, origins: tracker.paused.by.map(by => by.origin), draft: tracker.paused.draft },
    branches: tracker.branches.map(branch => ({
      id: branch.id, name: branch.name, base: branch.base, tip: branch.tip, main: branch.id === tracker.mainBranch,
      locked: branch.locked, archived: branch.archived, n_notes: branch.notes.length,
      path: pathTo(tracker, branch.tip).map(step => step.id),
      own: tracker.steps.filter(step => step.branch === branch.id).map(step => step.id),
    })),
    tips: [...tips],
    groups: tracker.groups.map(group => {
      const members = tracker.steps.filter(step => step.group === group.id).map(step => step.id);
      return {
        id: group.id, name: group.name, branch: stepOf(tracker, members[0]).branch, first: members[0], last: members[members.length - 1],
        steps: members, n_notes: group.notes.length,
      };
    }),
    squashed: tracker.steps.filter(step => step.kind === 'squashed').map(step => ({
      step: step.id, cause: step.squashed.cause, count: step.squashed.count, origins: step.squashed.by.map(by => by.origin),
      touches: [...step.touches], carried: { notes: [...step.squashed.carried.notes], bookmarks: [...step.squashed.carried.bookmarks] },
    })),
    steps: { columns: [...STEP_COLUMNS], rows: tracker.steps.map(step => stepRow(tracker, step, stale)) },
    turns: tracker.turns.map(turn => ({
      id: turn.id, label: turn.label, origin: turn.by.origin, branch: turn.branch,
      steps: tracker.steps.filter(step => step.by.turn === turn.id).map(step => step.id),
      summary: turn.notes.length > 0 ? turn.notes[0].text : null,
    })),
    notes: [
      ...tracker.notes.map(note => ({ id: note.id, on: { tracker: tracker.id }, text: note.text, origin: note.by.origin })),
      ...tracker.branches.flatMap(branch => branch.notes.map(note => ({ id: note.id, on: { branch: branch.id }, text: note.text, origin: note.by.origin }))),
      ...tracker.groups.flatMap(group => group.notes.map(note => ({ id: note.id, on: { group: group.id }, text: note.text, origin: note.by.origin }))),
      ...tracker.steps.flatMap(step => step.notes.map(note => ({ id: note.id, on: { step: step.id }, text: note.text, origin: note.by.origin }))),
      ...tracker.turns.flatMap(turn => turn.notes.map(note => ({ id: note.id, on: { turn: turn.id }, text: note.text, origin: note.by.origin }))),
    ].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))),
    journal: tracker.journal.map(entry => ({ id: entry.id, op: entry.op, label: entry.label, purged: entry.purged })),
    stale: staleAt(tracker),
    conversations: tracker.chats.map(([conversation]) => conversation),
  };
}

/** The diff of two states, as Python and R write it: the four data domains in the web's words, every other by its name. */
const DESCRIBE = {
  cells: createCellsDomain({ openCells: Object.fromEntries(['subset', 'geneSample', 'genesAsked', 'setGenesAsked', 'reopen', 'readGenes'].map(name => [name, () => null])) }).describe,
  'field-overlays': createFieldOverlaysDomain({ state: null, viewer: null, refreshUi: () => {} }).describe,
  'gene-sets': createGeneSetsDomain({ state: null }).describe,
  highlights: createHighlightsDomain({ state: null, refreshUi: () => {} }).describe,
};

function diffRows(a, b) {
  const rows = [];
  const va = statesOf.get(a);
  const vb = statesOf.get(b);
  for (const domain of DOMAIN_IDS) {
    const ha = valueHashSync(va[domain]);
    const hb = valueHashSync(vb[domain]);
    if (ha === hb) continue;
    const lines = Object.hasOwn(DESCRIBE, domain) ? DESCRIBE[domain](va[domain], vb[domain]) : [];
    for (const line of (lines.length > 0 ? lines : [`${domainName(domain)} changed`])) rows.push({ domain, name: domainName(domain), line });
  }
  return rows;
}

/** A value's hash, from the pool (every value of a state was hashed when it was recorded). */
const hashOf = new Map();
function valueHashSync(value) {
  return hashOf.get(value);
}

/** The methods paragraph of a branch, written by the web's own export (`exports/methods.js`). */
function methodsText(tracker, branchId, app) {
  return methodsParagraph({
    tracker, branch: branchId, dataset: { name: DATASET_NAME, cells: N, genes: GENES.length, citation: null, openCells: null },
    version: app.version, cellucidCitation: null,
  });
}

/** A branch's steps as pseudocode, written by the web's own export (`exports/pseudocode.js`). */
function pseudocodeText(tracker, branchId, app) {
  return historyPseudocode({ tracker, branch: branchId, dataset: { name: DATASET_NAME }, version: app.version });
}

// ---------------------------------------------------------------------------
// The apply plans, as the rules give them (one object, applied in order)

const PRESENTATION_NOTE = 'Presentation: not applied to the object.';
const DATA_DOMAINS = new Set(['cells', 'field-overlays', 'gene-sets', 'highlights']);

function countKnown(values) {
  let n = 0;
  for (const value of values) if (!Number.isNaN(value)) n++;
  return n;
}

/** Presentation rows: every other domain whose value at the step differs from the tracker's root. */
function presentationRows(tracker, stepId) {
  const at = statesOf.get(`${tracker.id}/${stepId}`);
  const root = statesOf.get(`${tracker.id}/s0`);
  return DOMAIN_IDS.filter(domain => !DATA_DOMAINS.has(domain) && valueHashSync(at[domain]) !== valueHashSync(root[domain]))
    .map(domain => ({ kind: 'presentation', domain, name: domainName(domain), column: null, from: [], cells: null, status: 'not-applied', note: PRESENTATION_NOTE }));
}

function inDomainOrder(rows) {
  return DOMAIN_IDS.flatMap(domain => rows.filter(row => row.domain === domain));
}

function row(kind, domain, name, status, extra = {}) {
  return { kind, domain, name, column: null, from: [], cells: null, status, note: null, ...extra };
}

function plans(annotation) {
  const nkCells = range(0, N).filter(i => cellTypeOf(i) === 2).length;
  const scoreKnown = countKnown(scoreValues);
  // 1. The head (s13 on Main): every row written.
  const head = inDomainOrder([
    row('categories-renamed', 'field-overlays', 'NK', 'write', { column: 'cell_type', from: ['NK cell'], cells: nkCells }),
    row('user-field', 'field-overlays', 'score', 'write', { cells: scoreKnown }),
    row('user-field', 'field-overlays', 'cell_type (merged)', 'write', { cells: N }),
    row('gene-set', 'gene-sets', 'T cell markers', 'write'),
    row('highlight', 'highlights', 'cellucid_highlight__QC__Doublets', 'write', { cells: doublets.length }),
    ...presentationRows(annotation, 's13'),
  ]);
  // 2. The head again: nothing to write.
  const again = head.map(entry => {
    if (entry.status !== 'write') return entry;
    // A category already renamed labels no cell anew.
    return { ...entry, status: 'unchanged', cells: entry.kind.startsWith('categories-') ? null : entry.cells };
  });
  // 3. The bookmark (s5) after the head: what it holds is there already.
  const bookmark = inDomainOrder([
    row('categories-renamed', 'field-overlays', 'NK', 'unchanged', { column: 'cell_type', from: ['NK cell'] }),
    row('user-field', 'field-overlays', 'score', 'unchanged', { cells: scoreKnown }),
    row('gene-set', 'gene-sets', 'T cell markers', 'unchanged'),
    row('highlight', 'highlights', 'cellucid_highlight__QC__Doublets', 'unchanged', { cells: doublets.length }),
    ...presentationRows(annotation, 's5'),
  ]);
  // 4. Another branch's tip (s8 on "Without score") after them: a column
  //    renamed and a highlight written, the rest there already.
  const branch = inDomainOrder([
    row('column-renamed', 'field-overlays', 'cluster', 'write', { from: ['leiden'] }),
    row('categories-renamed', 'field-overlays', 'NK', 'unchanged', { column: 'cell_type', from: ['NK cell'] }),
    row('highlight', 'highlights', 'cellucid_highlight__QC__Doublets', 'unchanged', { cells: doublets.length }),
    row('highlight', 'highlights', 'cellucid_highlight__Types__cell_type_T_cell', 'write', { cells: tCells.length }),
    ...presentationRows(annotation, 's8'),
  ]);
  // The var columns each apply writes (a gene set written or replaced): one
  // boolean per var row, true on the genes the set lists.
  const geneSetColumn = (name, genes) => ({ name, values: GENES.map(gene => genes.includes(gene)) });
  const headVar = [geneSetColumn('cellucid_gene_set__T_cell_markers', ['CD3E', 'NKG7'])];
  return [
    { name: 'head', tracker: T1, branch: null, step: null, expect: { tracker: T1, branch: 'b0', step: 's13' }, requires: { obs: [], var: ['CD3E'] }, rows: head, var_columns: headVar, applied: true },
    { name: 'again', tracker: T1, branch: null, step: null, expect: { tracker: T1, branch: 'b0', step: 's13' }, requires: { obs: [], var: ['CD3E'] }, rows: again, var_columns: [], applied: false },
    { name: 'bookmark', tracker: 'Annotation', branch: null, step: 's5', expect: { tracker: T1, branch: 'b0', step: 's5' }, requires: { obs: ['cell_type'], var: [] }, rows: bookmark, var_columns: [], applied: false },
    { name: 'branch', tracker: null, branch: 'Without score', step: null, expect: { tracker: T1, branch: 'b1', step: 's8' }, requires: { obs: ['cell_type'], var: [] }, rows: branch, var_columns: [], applied: true },
  ];
}

/** What the first apply (the head) records, but for its time, version and package. */
function headProvenance(sha, rows) {
  return {
    session_sha256: sha, tracker: T1, branch: 'b0', step: 's13',
    columns: rows.filter(entry => ['user-field', 'highlight'].includes(entry.kind) && ['write', 'replace'].includes(entry.status)).map(entry => entry.name),
    renamed: [{ kind: 'category', column: 'cell_type', from: 'NK cell', to: 'NK' }],
    skipped: rows.filter(entry => entry.status === 'not-applied').map(entry => ({ kind: entry.kind, name: entry.name, note: entry.note })),
    // The head's expression values (its `expression` value, the opening's).
    expression: { ...statesOf.get(`${T1}/s13`).expression },
    session: null,
  };
}

// ---------------------------------------------------------------------------
// Everything, written

/**
 * The golden history as the writer takes it: the trackers (the model's
 * records), the values by hash, and the header, stamps and scope of its file.
 * The persistence tests write and read it (`tests/session-history-file.test.mjs`).
 */
export async function goldenSession() {
  minute = 0;
  pool.clear();
  statesOf.clear();
  hashOf.clear();
  const annotation = await makeAnnotation();
  const replay = await makeReplay(annotation);
  const removed = await makeRemoved();
  const trackers = [annotation, replay, removed];
  for (const state of statesOf.values()) for (const value of Object.values(state)) hashOf.set(value, await hashValue(value));

  const app = await appStamp({ catalog, version: '0.9.6' });
  if (app.catalog !== createHash('sha256').update(renderActionCatalog()).digest('hex')) throw new Error('The app stamp is not the catalog document\'s digest');
  // One stamp per action and version its steps (journal included) use.
  const actions = await actionStamps(trackers.flatMap(tracker => [
    ...tracker.steps, ...tracker.journal.flatMap(entry => (entry.purged ? [] : [...entry.before.steps, ...entry.after.steps])),
  ]), catalog);
  const scope = {
    trackers: trackers.map(tracker => tracker.id),
    branches: trackers.map(tracker => ({ tracker: tracker.id, branches: tracker.branches.map(branch => branch.id) })),
    content: 'history', results: 'include', notes: true, chats: true, journal: true, times: 'exact', source: 'full',
  };
  const header = {
    createdAt: '2026-11-04T12:00:00.000Z',
    datasetFingerprint: {
      datasetId: DATASET_ID, name: DATASET_NAME, cellCount: N, varCount: GENES.length, cellOrder: CELL_ORDER, dataMapping: mapping,
    },
    source: { kind: 'sample', dataset: DATASET_ID },
    requires: { obs: [], var: ['CD3E'] },
  };
  validateSession({ ...header, app, actions, scope, cells: null, genes: null, activeTracker: T1, trackers });
  return { trackers, activeTracker: T1, header, app, actions, scope, values: new Map(pool), catalog };
}

/** The golden session file and its expected reading, made afresh (the same bytes every run). */
export async function buildHistoryGolden() {
  const { trackers, header, app, actions, scope } = await goldenSession();
  const [annotation, replay] = trackers;
  const file = await writeSession(trackers, { activeTracker: T1, header, app, actions, scope });
  const sha = createHash('sha256').update(file.bytes).digest('hex');

  const valueAt = (tracker, step) => {
    const state = statesOf.get(`${tracker}/${step}`);
    return Object.fromEntries(DOMAIN_IDS.map(domain => [domain, valueHashSync(state[domain])]));
  };
  const list = array => Array.from(array, value => (Number.isNaN(value) ? null : value));
  const expected = {
    about: 'What reading and applying history-golden.cellucid-session must give (scripts/generate-history-golden.mjs).',
    sha256: sha,
    dataset: {
      id: DATASET_ID, name: DATASET_NAME, n_obs: N, obs_names: range(0, N).map(i => `cell_${i}`),
      obs: {
        cell_type: { categories: CELL_TYPES, codes: range(0, N).map(cellTypeOf) },
        leiden: { categories: LEIDEN, codes: range(0, N).map(leidenOf) },
      },
      var_names: GENES,
      obsm: { X_umap: range(0, N).map(i => [UMAP[2 * i], UMAP[2 * i + 1]]) },
      cell_order_digest: CELL_ORDER.digest,
    },
    session: {
      created_at: header.createdAt, app, scope, requires: header.requires, chrome: GOLDEN_CHROME, active_tracker: T1,
      actions: actions.map(entry => entry.type),
      values: file.valueCount,
    },
    trackers: trackers.map(readingOf),
    states: {
      head: { tracker: T1, step: 's13', values: valueAt(T1, 's13') },
      bookmark: { tracker: T1, step: 's5', values: valueAt(T1, 's5') },
      nested: { tracker: T1, step: 's9', values: valueAt(T1, 's9') },
    },
    values: {
      score: { cells: list(scoreCells), values: list(scoreValues) },
      doublets: list(doublets),
      t_cells: list(tCells),
      merged: { categories: mergedCategories, codes: list(mergedField.codes.values) },
    },
    diffs: [
      { a: { tracker: T1, step: 's5' }, b: { tracker: T1, step: 's13' }, rows: diffRows(`${T1}/s5`, `${T1}/s13`) },
      { a: { tracker: T1, step: 's13' }, b: { tracker: T1, step: 's9' }, rows: diffRows(`${T1}/s13`, `${T1}/s9`) },
      { a: { tracker: T2, step: 's2' }, b: { tracker: T1, step: 's2' }, rows: diffRows(`${T2}/s2`, `${T1}/s2`) },
    ],
    methods: [
      { tracker: T1, branch: 'b0', text: methodsText(annotation, 'b0', app) },
      { tracker: T1, branch: 'b2', text: methodsText(annotation, 'b2', app) },
      { tracker: T1, branch: 'b3', text: methodsText(annotation, 'b3', app) },
    ],
    pseudocode: [
      { tracker: T1, branch: 'b0', text: pseudocodeText(annotation, 'b0', app) },
      { tracker: T1, branch: 'b3', text: pseudocodeText(annotation, 'b3', app) },
      { tracker: T2, branch: 'b0', text: pseudocodeText(replay, 'b0', app) },
    ],
    apply: {
      presentation_note: PRESENTATION_NOTE,
      sequence: plans(annotation),
      provenance: null,
    },
  };
  expected.apply.provenance = headProvenance(sha, expected.apply.sequence[0].rows);
  const expectedText = `${JSON.stringify(expected, null, 2)}\n`;
  return { file, sha, expectedText };
}

/**
 * The golden's current state only, as Share › Current state only writes it
 * (`share-scope.js` `writeSharedHistory`): one tracker of the opening and one
 * squashed step to what the golden's active tracker shows; nobody named, no
 * time, no note. The packages read it as they read the web app's own share.
 */
export async function buildHistoryGoldenState() {
  const session = await goldenSession();
  const active = session.trackers.find(tracker => tracker.id === session.activeTracker);
  const { blob } = await writeSharedHistory({
    snapshot: { dataset: active.dataset, activeTracker: session.activeTracker, trackers: session.trackers },
    shown: valuesAtStep(active.steps, active.headId), valueOf: hash => session.values.get(hash), choice: STATE_DEFAULTS,
    header: session.header, catalog, version: session.app.version, newTrackerId: () => 't-5a1e0000-0000-4000-8000-000000000001',
    now: Date.parse(session.header.createdAt),
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/** What a session file holds: its manifest and each chunk's payload, inflated. */
export function historyGoldenContent(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = 'CELLUCID_SESSION/4\n'.length;
  const manifestLength = view.getUint32(signature, true);
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(signature + 4, signature + 4 + manifestLength)));
  let at = signature + 4 + manifestLength;
  const payloads = [];
  for (const meta of manifest.chunks) {
    const length = view.getUint32(at, true);
    const stored = bytes.subarray(at + 4, at + 4 + length);
    payloads.push(Buffer.from(meta.codec === 'gzip' ? gunzipSync(stored) : stored).toString('base64'));
    at += 4 + length;
  }
  const normal = manifest.chunks.map(({ storedBytes: _stored, ...meta }) => meta);
  return JSON.stringify({ manifest: { ...manifest, chunks: normal }, payloads });
}

/**
 * A reading made afresh, as it reads for the session file `session`. A reading
 * names the digest of the file it goes with, and that digest is of gzip's
 * bytes, which differ between one zlib and another (three digests from one
 * content on the Linux, macOS and Windows runners of CI run 42129386525):
 * everything else in a reading is the same on every machine.
 */
export function historyGoldenExpectedOf(expectedText, session) {
  const sha = createHash('sha256').update(session).digest('hex');
  return expectedText.replace(/"(sha256|session_sha256)": "[0-9a-f]{64}"/g, (_, key) => `"${key}": "${sha}"`);
}

/** Each place the files go: this repository's, then each package's (null when absent). */
export function historyGoldenTargets(env = process.env) {
  return [
    { repository: 'cellucid', session: HISTORY_GOLDEN_SESSION_PATH, expected: HISTORY_GOLDEN_EXPECTED_PATH, state: HISTORY_GOLDEN_STATE_PATH, example: null },
    ...HISTORY_GOLDEN_MIRRORS.map(mirror => {
      const root = env[mirror.env] ?? path.join(ROOT, '..', mirror.repository);
      const present = existsSync(root);
      return {
        repository: mirror.repository, env: mirror.env,
        session: present ? path.join(root, mirror.dir, PACKAGE_SESSION_NAME) : null,
        expected: present ? path.join(root, mirror.dir, PACKAGE_EXPECTED_NAME) : null,
        state: present ? path.join(root, mirror.dir, PACKAGE_STATE_NAME) : null,
        example: present && mirror.example !== null ? path.join(root, mirror.example, PACKAGE_SESSION_NAME) : null,
      };
    }),
  ];
}

async function readOrNull(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const unknown = process.argv.slice(2).filter(argument => argument !== '--check');
  if (unknown.length > 0) throw new Error(`Unknown argument ${unknown[0]}; the only one is --check`);
  const { file, expectedText } = await buildHistoryGolden();
  const state = await buildHistoryGoldenState();
  let stale = 0;
  let written = file.bytes;
  for (const target of historyGoldenTargets()) {
    if (target.session === null) {
      console.log(`skipped ${target.repository}: not found (set ${target.env})`);
      continue;
    }
    const session = await readOrNull(target.session);
    const expected = await readOrNull(target.expected);
    const stateNow = await readOrNull(target.state);
    const example = target.example === null ? null : await readOrNull(target.example);
    if (check) {
      const exampleSame = target.example === null || (example !== null && session !== null && example.equals(session));
      const same = exampleSame && stateNow !== null && historyGoldenContent(new Uint8Array(stateNow)) === historyGoldenContent(state) && session !== null && historyGoldenContent(new Uint8Array(session)) === historyGoldenContent(file.bytes)
        && expected !== null && expected.toString('utf8') === historyGoldenExpectedOf(expectedText, session);
      console.log(`${same ? 'current' : 'stale  '} ${target.repository}`);
      if (!same) stale += 1;
      continue;
    }
    await mkdir(path.dirname(target.session), { recursive: true });
    await writeFile(target.session, written);
    await writeFile(target.expected, expectedText);
    await writeFile(target.state, state);
    if (target.example !== null) {
      await mkdir(path.dirname(target.example), { recursive: true });
      await writeFile(target.example, written);
    }
    console.log(`wrote   ${target.repository}`);
  }
  if (!check) {
    console.log(`sha256  ${createHash('sha256').update(written).digest('hex')}  session`);
    console.log(`sha256  ${createHash('sha256').update(expectedText).digest('hex')}  expected`);
    console.log(`sha256  ${createHash('sha256').update(state).digest('hex')}  state`);
  }
  if (stale > 0) {
    console.log('Run node scripts/generate-history-golden.mjs and pin the printed digests in the three repositories.');
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
