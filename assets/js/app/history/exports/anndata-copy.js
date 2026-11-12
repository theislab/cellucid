/**
 * @fileoverview The apply plan of "Save AnnData with this state…": one step
 * of a tracker applied to the dataset it was recorded on, as the rows
 * cellucid-python's `apply_cellucid_session_to_anndata` and cellucid-r's
 * `cellucid_apply_session()` plan, and the changes a copy of the dataset
 * writes for them (`data/anndata/write/copy.js` `CopyChanges`). Pure: no
 * page, no reader; what it reads of the dataset comes through `target`.
 *
 * The rules are the packages' (History v2 §3.14 and the H4 notes), pinned by
 * the shared expected plan `history-golden.expected.json`
 * (`expected.apply.sequence`, `tests/history-anndata-copy.test.mjs`):
 *
 * - **Rows**, in domain order. `field-overlays`: renamed obs columns, then
 *   renamed categories (`categories-merged` when the new label is one the
 *   column has, or another rename of the column takes it too), then deleted
 *   fields (recorded, never applied), then user-defined fields (a column
 *   each, by its key); `gene-sets`: one row per set; `highlights`: one
 *   column per group of every page (`cellucid_highlight__<page>__<group>`);
 *   `colors`: one `column-colors` row per dataset column the view in focus
 *   recolored categories of (in the `colors` value's order), then the
 *   domain's `presentation` row; every other domain whose value at the step
 *   differs from the tracker's opening is one `presentation` row, not applied.
 * - **Statuses**: `write` (the dataset lacks it); `unchanged` (it holds it
 *   already: a copy of a copy applies nothing twice); `replace` (a column or
 *   gene set an earlier apply wrote, with `overwrite`); `not-applied` with
 *   the reason (a column the person made is never replaced, a column or
 *   category the dataset lacks, a deletion, a presentation domain).
 * - **Cells**: a value names cells by original position; a cell the viewer
 *   did not open (`known`: the open cells of a subsample) is unknown, so it
 *   is missing in a field's column and `<NA>` in a highlight's (a nullable
 *   boolean), never "not selected".
 * - **Provenance**: one record appended to `uns['cellucid']['history_applied']`
 *   (JSON text of the model's `Provenance`, `package: 'web'`) when anything
 *   is written. It records the step's expression values (`expression`: the
 *   `expression` value, `{normalize, log1p}`, null when the session holds
 *   none), so a notebook knows what the person looked at the genes in; X is
 *   never changed (the transform is a way of showing the values, a
 *   `presentation` row like the others). Gene sets go to `uns['cellucid']['gene_sets']` by name, as
 *   the packages write them (origin `session`, `pulled_from: 'viewer'`), and,
 *   one boolean column each, to the var of the genes the data mapping reads
 *   (`geneSetColumns`: `cellucid_gene_set__<name>`, the highlight columns'
 *   naming rule), true on the rows whose gene (as the mapping names genes)
 *   the set lists. Only a set written or replaced gets its column: a new one
 *   is added after var's columns, an earlier apply's (`replace`) is replaced
 *   in place, and a var column of that name beside a set no apply wrote is
 *   the dataset's own, never replaced. A mapping that reads the raw matrix's
 *   genes (`raw.var`) or none has no var to mark: the sets stay in `uns`
 *   only. A set the step no longer holds has no row (as a field the step
 *   lacks): its record and its column stay. cellucid-python and cellucid-r
 *   write the same columns (`expected.apply.sequence[].var_columns`).
 * - **Colors**: a column's colors go with it, as Scanpy keeps them
 *   (`uns['<column>_colors']`, `colorChanges`): a categorical user field
 *   written with the colors it is shown in (`shownCategoryColors`): in the
 *   view in focus at the step, the color the person or an agent gave a
 *   category (the `colors` value), else the color it opens with -- its
 *   `palette` (a field made from highlight pages: its pages'), else
 *   Cellucid's own category colors by position (`getCategoryColor`); any
 *   other column written with none (the colors under its name described
 *   another column); a renamed column's carried along; a relabeled
 *   categorical's kept, a merged category taking its first category's color.
 *   A dataset column recolored in the view in focus (`planColumnColors`)
 *   takes the colors it is shown in, under its name after the apply's
 *   renames: each category, by its label once relabeled, the color the person
 *   or an agent gave it, else the color it opens with -- the colors Scanpy
 *   keeps for the column (`openingPalette`, as drawn; a category merged by
 *   the apply takes its first source's), else Cellucid's own by position.
 *   Its row is `write`, `unchanged` (the column would hold those colors after
 *   the apply's other changes) or `not-applied` with the reason (a column the
 *   dataset lacks, a MuData modality's, one not categorical, or none of the
 *   categories recolored). The `colors` presentation row stays `not-applied`
 *   (every other color is how the data was shown), its note saying so when a
 *   field's recolors were written or any `column-colors` row is not
 *   `not-applied` (`COLORS_NOTE`).
 *
 * What the browser checks that the packages check differently: nothing of
 * the fingerprint (the copy is made of the dataset the history was recorded
 * on, open now), and the cells known are the open cells.
 *
 * @module app/history/exports/anndata-copy
 */

import { DOMAIN_IDS, domainName } from '../../actions/domains.js';
import { liveTracker, valuesAt, stepOf, pathTo } from '../tree.js';
import { nameKey, validateRecord } from '../model.js';
import { countNoun, formatCountOf } from '../../../utils/format-units.js';
import { requireExpressionTransform } from '../../../data/expression-transform.js';
import { getCategoryColor } from '../../../data/palettes.js';
import { HEX_COLOR, bytesOfHex, hexOfBytes, hexOfRgb01 } from '../../../utils/hex-color.js';

/** The domains an apply writes; every other domain is presentation. */
export const DATA_DOMAINS = Object.freeze(['cells', 'field-overlays', 'gene-sets', 'highlights']);
/** Why a presentation domain is not applied (the packages' words). */
export const PRESENTATION_NOTE = 'Presentation: not applied to the object.';
/** The colors row's note when a field's colors went with its column (the packages' words). */
export const COLORS_NOTE = 'The colors of the user fields written and of the dataset columns recolored go with their columns '
  + "(uns['<column>_colors']); every other color is how the data was shown: not applied to the object.";
/** The plan row of a dataset column's colors. */
export const COLUMN_COLORS_KIND = 'column-colors';
/** The start of every highlight group's obs column (as `pull` and the packages name it). */
export const HIGHLIGHT_PREFIX = 'cellucid_highlight__';
/** The start of every gene set's var column. */
export const GENE_SET_PREFIX = 'cellucid_gene_set__';
/** Where an apply records itself, and where gene sets go (`uns['cellucid']`). */
export const HISTORY_APPLIED_KEY = 'history_applied';
export const GENE_SETS_KEY = 'gene_sets';
/** Where the gene sets of a browser copy were pulled from: the viewer itself, as a live pull says. */
export const PULLED_FROM_VIEWER = 'viewer';

export const GENE_NAME_NOTE = 'A gene\'s display name is recorded, never applied to the object.';
export const GENE_CATEGORY_NOTE = 'A gene has no categories.';
export const DELETION_NOTE = 'A deletion is recorded, never applied to the object: the column stays.';
export const DELETED_NOTE = 'Deleted in the session.';
export const PURGED_NOTE = 'Deleted for good in the session: it holds no values.';

const absentColumnNote = column => `The object has no obs column "${column}".`;
const modalityColumnNote = column => `"${column}" is a column of a MuData modality; labels apply to the global obs.`;
const takenColumnNote = column => `The object already has an obs column "${column}" that Cellucid did not write; it is never replaced.`;
const numbersNote = column => `The obs column "${column}" holds numbers, not categories.`;
const noCategoryNote = (column, category) => `The obs column "${column}" has no category "${labelText(category)}".`;
const ownedNote = (name, step) => `An earlier apply (step ${step}) wrote "${name}" with other values; overwrite replaces it.`;
const takenSetNote = name => `The object already has a gene set "${name}" that no session wrote; it is never replaced.`;
const modalityColorsNote = column => `"${column}" is a column of a MuData modality; colors apply to the global obs.`;
const notCategoricalColorsNote = column => `The obs column "${column}" is not categorical; Scanpy keeps colors for a categorical column only.`;
const missingCategoriesNote = (column, labels) => `Not written: the ${countNoun(labels.length, 'color')} of ${labels.map(label => `"${label}"`).join(', ')}, `
  + `which the obs column "${column}" does not have.`;

// ---------------------------------------------------------------------------
// Names and labels

const NOT_A_WORD = /[^A-Za-z0-9]+/g;

/**
 * A name as part of a column name: each run of characters other than ASCII
 * letters and digits one underscore, none at either end; `identifier` when
 * nothing is left.
 */
export function columnPart(text, identifier) {
  const part = text.replace(NOT_A_WORD, '_').replace(/^_+|_+$/g, '');
  return part === '' ? identifier : part;
}

/** `name`, or `name_2`, `name_3`… -- the first not in `taken` -- added to `taken`. */
export function uniqueColumn(name, taken) {
  let candidate = name;
  for (let number = 2; taken.has(candidate); number++) candidate = `${name}_${number}`;
  taken.add(candidate);
  return candidate;
}

/** A highlight group's obs column: `cellucid_highlight__<page>__<group>`. */
export function highlightColumn(page, pageId, label, groupId) {
  return `${HIGHLIGHT_PREFIX}${columnPart(page, pageId)}__${columnPart(label, groupId)}`;
}

/** A category label as text, as JavaScript writes it (`1`, `1.5`, `true`). */
export function labelText(value) {
  return typeof value === 'string' ? value : String(value);
}

/** A category label's identity as JavaScript tells labels apart: `1` and `"1"` differ. */
function identity(value) {
  return `${typeof value}\u0000${String(value)}`;
}

/** Sorted as JavaScript sorts text (by UTF-16 code units). */
const sortText = values => [...values].sort();

// ---------------------------------------------------------------------------
// Choosing the step

/**
 * The tracker, branch and step an apply takes, as the packages choose them:
 * the step asked for (on the branch asked for, when both are), a branch's
 * tip, or the tracker's head on its active branch. Trackers and branches
 * by name or id.
 *
 * @param {object[]} trackers - The model's `Tracker` records
 * @param {{activeTracker?: string|null, tracker?: string|null, branch?: string|null, step?: string|null}} [options]
 * @returns {{tracker: object, live: object, branch: string, step: string}}
 */
export function chooseStep(trackers, { activeTracker = null, tracker = null, branch = null, step = null } = {}) {
  const inUse = trackers.filter(record => (record.removed ?? null) === null);
  const ref = tracker ?? activeTracker;
  const record = ref === null ? inUse[0] : inUse.find(each => each.id === ref) ?? inUse.find(each => nameKey(each.name) === nameKey(ref));
  if (record === undefined) throw new RangeError(`There is no tracker "${ref}" in this history.`);
  const live = liveTracker(record);
  const branchNamed = name => {
    const found = record.branches.find(each => each.id === name) ?? record.branches.find(each => nameKey(each.name) === nameKey(name));
    if (found === undefined) throw new RangeError(`There is no branch "${name}" in the tracker "${record.name}".`);
    return found;
  };
  if (step !== null) {
    const chosen = stepOf(live, step);
    if (branch === null) return { tracker: record, live, branch: chosen.branch, step: chosen.id };
    const on = branchNamed(branch);
    if (!pathTo(live, on.tip).some(each => each.id === chosen.id)) {
      throw new RangeError(`Step ${chosen.id} is not on the branch "${on.name}" (its path runs from the root to step ${on.tip}).`);
    }
    return { tracker: record, live, branch: on.id, step: chosen.id };
  }
  if (branch !== null) {
    const on = branchNamed(branch);
    return { tracker: record, live, branch: on.id, step: on.tip };
  }
  return { tracker: record, live, branch: record.activeBranch, step: record.headId };
}

/**
 * The dataset fields a step's state uses: every obs column and gene a view
 * colors by or filters on, or a highlight group is bound to, by the key
 * the dataset gives it (fields the session made are not listed).
 */
export function requiredFields(valueOf) {
  const required = { obs: new Set(), var: new Set() };
  const add = ref => {
    if (ref !== null && typeof ref === 'object' && typeof ref.key === 'string' && Object.hasOwn(required, ref.source)) required[ref.source].add(ref.key);
  };
  for (const domain of ['filters', 'colors']) {
    for (const view of valueOf(domain)?.views ?? []) for (const entry of view ?? []) add(entry?.field ?? null);
  }
  for (const ref of valueOf('active-field')?.views ?? []) add(ref);
  for (const page of valueOf('highlights')?.pages ?? []) for (const group of page.groups ?? []) add(group.field ?? null);
  return { obs: sortText(required.obs), var: sortText(required.var) };
}

// ---------------------------------------------------------------------------
// Columns

/** Integer codes of the smallest signed type that names `count` categories and -1. */
function codeArray(count, length) {
  if (count < 0x80) return new Int8Array(length);
  if (count < 0x8000) return new Int16Array(length);
  return new Int32Array(length);
}

/** Cells outside `known` (ascending original positions; null: every cell) as a mask. */
function unknownMask(nObs, known) {
  if (known === null) return null;
  const unknown = new Uint8Array(nObs).fill(1);
  for (let i = 0; i < known.length; i++) unknown[known[i]] = 0;
  return unknown;
}

/** A categorical user field over every cell: its codes placed at its cells, missing elsewhere and outside `known`. */
function categoricalColumn(field, nObs, unknown) {
  const { cells, values } = field.codes;
  const missing = 2 ** (8 * values.BYTES_PER_ELEMENT) - 1;
  const codes = codeArray(field.categories.length, nObs).fill(-1);
  for (let i = 0; i < values.length; i++) {
    const cell = cells === null ? i : cells[i];
    const code = values[i];
    if (code !== missing && (unknown === null || unknown[cell] === 0)) codes[cell] = code;
  }
  let count = 0;
  for (let i = 0; i < nObs; i++) if (codes[i] >= 0) count++;
  return { column: { kind: 'categorical', codes, categories: field.categories.map(labelText), ordered: false }, cells: count };
}

/** Numbers over every cell (`float32`, or `float64` when they came so): NaN where none, or unknown. */
function numbersColumn(part, nObs, unknown) {
  const { cells, values } = part;
  const out = new (values instanceof Float64Array ? Float64Array : Float32Array)(nObs).fill(Number.NaN);
  for (let i = 0; i < values.length; i++) {
    const cell = cells === null ? i : cells[i];
    if (unknown === null || unknown[cell] === 0) out[cell] = values[i];
  }
  let count = 0;
  for (let i = 0; i < nObs; i++) if (!Number.isNaN(out[i])) count++;
  return { column: { kind: 'numbers', values: out }, cells: count };
}

/** A highlight group's membership: `bool`, or a nullable boolean with every unknown cell `<NA>`. */
function membershipColumn(cells, nObs, unknown) {
  const values = new Uint8Array(nObs);
  for (let i = 0; i < cells.length; i++) values[cells[i]] = 1;
  let count = 0;
  for (let i = 0; i < nObs; i++) if (values[i] === 1 && (unknown === null || unknown[i] === 0)) count++;
  if (unknown === null) return { column: { kind: 'booleans', values }, cells: count };
  return { column: { kind: 'nullable-boolean', values, mask: unknown.slice() }, cells: count };
}

const sameArray = (a, b) => {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined || a.length !== b.length) return false;
  if (ArrayBuffer.isView(a) !== ArrayBuffer.isView(b)) return false;
  if (ArrayBuffer.isView(a) && a.constructor !== b.constructor) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i]) && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
  return true;
};

/**
 * Whether the dataset's column holds exactly the planned one (the same kind,
 * dtype and values; a categorical its categories in order and its codes).
 */
export function sameColumn(existing, planned) {
  if (existing === null || existing.kind !== planned.kind) return false;
  switch (planned.kind) {
    case 'categorical':
      return sameArray(existing.categories, planned.categories) && (existing.ordered === true) === (planned.ordered === true)
        && sameArray(Int32Array.from(existing.codes), Int32Array.from(planned.codes));
    case 'nullable-boolean':
    case 'nullable-integer':
      return sameArray(existing.mask, planned.mask) && existing.values.every((value, i) => existing.mask[i] === 1 || value === planned.values[i]);
    default:
      return sameArray(existing.values, planned.values);
  }
}

// ---------------------------------------------------------------------------
// Labels: renamed columns and categories

function labelRow(kind, name, status, extra = {}) {
  return { kind, domain: 'field-overlays', name, column: null, from: [], cells: null, status, note: null, ...extra };
}

/** A column's categories (a categorical's, a text column's values in order), or null for numbers. */
function labelsOf(column) {
  if (column.kind === 'categorical') return column.categories;
  if (column.kind === 'strings') {
    const seen = new Set();
    const out = [];
    for (const value of column.values) if (value !== null && !seen.has(value)) { seen.add(value); out.push(value); }
    return out;
  }
  return null;
}

function countOf(column, category) {
  const id = identity(category);
  let count = 0;
  if (column.kind === 'categorical') {
    const index = column.categories.findIndex(each => identity(each) === id);
    if (index < 0) return 0;
    for (let i = 0; i < column.codes.length; i++) if (column.codes[i] === index) count++;
    return count;
  }
  for (const value of column.values) if (value !== null && identity(value) === id) count++;
  return count;
}

/**
 * A categorical with categories renamed (merged where two read alike, in the
 * place of the first), as a copy writes it, and for each category after the
 * place of the first category before it was made from (its colors follow it).
 */
function renamedCategorical(column, renames) {
  const labels = [...column.categories];
  for (const [category, name] of renames) {
    const id = identity(category);
    column.categories.forEach((value, index) => { if (identity(value) === id) labels[index] = name; });
  }
  const merged = [];
  const sources = [];
  const position = new Map();
  const remap = new Int32Array(labels.length);
  labels.forEach((label, index) => {
    const id = identity(label);
    if (!position.has(id)) {
      position.set(id, merged.length);
      merged.push(label);
      sources.push(index);
    }
    remap[index] = position.get(id);
  });
  const codes = codeArray(merged.length, column.codes.length);
  for (let i = 0; i < codes.length; i++) codes[i] = column.codes[i] < 0 ? -1 : remap[column.codes[i]];
  // `labels`: the categories after as labels (a number stays one), as the viewer shows them.
  return { column: { kind: 'categorical', codes, categories: merged.map(labelText), ordered: column.ordered === true }, sources, labels: merged };
}

/** A text column with the values each rename names replaced. */
function renamedText(column, renames) {
  const values = column.values.slice();
  for (const [category, name] of renames) {
    const id = identity(category);
    for (let i = 0; i < values.length; i++) if (values[i] !== null && identity(values[i]) === id) values[i] = labelText(name);
  }
  return { kind: 'strings', values };
}

/**
 * The renames and deletions of a `field-overlays` value as rows against the
 * dataset's obs; `earlier` lists the renames earlier applies recorded.
 */
async function planLabels(overlays, target, earlier) {
  const present = target.obsColumns;
  const presentSet = new Set(present);
  const absent = column => {
    if (!presentSet.has(column) && target.modalityColumns.has(column)) return modalityColumnNote(column);
    if (!presentSet.has(column)) return absentColumnNote(column);
    return null;
  };
  const earlierColumns = earlier.filter(entry => entry.kind === 'column').map(entry => [entry.from, entry.to]);
  const earlierCategories = new Set(earlier.filter(entry => entry.kind === 'category').map(entry => `${entry.column}\u0000${entry.from}\u0000${entry.to}`));
  const rows = [];
  const rename = new Map();
  const renamed = [];

  // Columns: every applicable rename at once (two swapped names apply).
  const sources = new Set(overlays.renamedFields
    .filter(entry => entry.source === 'obs' && entry.name !== entry.key && presentSet.has(entry.key)).map(entry => entry.key));
  const kept = new Set(present.filter(name => !sources.has(name)));
  const targets = new Set();
  for (const { source, key, name } of overlays.renamedFields) {
    if (source === 'var') {
      rows.push(labelRow('column-renamed', name, 'not-applied', { from: [key], note: GENE_NAME_NOTE }));
      continue;
    }
    if (name === key) continue;
    const reason = absent(key);
    if (reason === null) {
      if (kept.has(name) || targets.has(name)) {
        rows.push(labelRow('column-renamed', name, 'not-applied', { from: [key], note: takenColumnNote(name) }));
        continue;
      }
      targets.add(name);
      rename.set(key, name);
      renamed.push({ kind: 'column', column: null, from: key, to: name });
      rows.push(labelRow('column-renamed', name, 'write', { from: [key] }));
    } else if (presentSet.has(name) && earlierColumns.some(([from, to]) => from === key && to === name)) {
      rows.push(labelRow('column-renamed', name, 'unchanged', { from: [key] }));
    } else {
      rows.push(labelRow('column-renamed', name, 'not-applied', { from: [key], note: reason }));
    }
  }

  // Categories, in the column each is in once the columns are renamed.
  const earlierNames = new Map(earlierColumns);
  const byColumn = new Map();
  const targetsOf = new Map();
  for (const entry of overlays.renamedCategories) {
    if (entry.source !== 'obs') continue;
    if (!targetsOf.has(entry.field)) targetsOf.set(entry.field, []);
    targetsOf.get(entry.field).push(identity(entry.name));
  }
  for (const { source, field, category, name } of overlays.renamedCategories) {
    const extra = { column: field, from: [labelText(category)] };
    if (source === 'var') {
      rows.push(labelRow('categories-renamed', labelText(name), 'not-applied', { ...extra, note: GENE_CATEGORY_NOTE }));
      continue;
    }
    const before = presentSet.has(field) ? field : earlierNames.get(field) ?? field;
    const after = rename.get(before) ?? before;
    const reason = absent(before);
    if (reason !== null) {
      rows.push(labelRow('categories-renamed', labelText(name), 'not-applied', { ...extra, note: reason }));
      continue;
    }
    const column = await target.column(before);
    const labels = column === null ? null : labelsOf(column);
    if (labels === null) {
      rows.push(labelRow('categories-renamed', labelText(name), 'not-applied', { column: after, from: [labelText(category)], note: numbersNote(after) }));
      continue;
    }
    const ids = labels.map(identity);
    const hasFrom = ids.includes(identity(category));
    const hasTo = ids.includes(identity(name));
    const shared = targetsOf.get(field).filter(id => id === identity(name)).length > 1;
    // Into a category the column holds beside it, or the same as another
    // rename of the column: two categories become one. Once applied, the
    // source is gone and only the shared target tells.
    const merged = shared || (hasFrom && hasTo && identity(category) !== identity(name));
    const kind = merged ? 'categories-merged' : 'categories-renamed';
    if (hasFrom) {
      if (!byColumn.has(before)) byColumn.set(before, { column, renames: [] });
      byColumn.get(before).renames.push([category, name]);
      renamed.push({ kind: 'category', column: after, from: labelText(category), to: labelText(name) });
      rows.push(labelRow(kind, labelText(name), 'write', { column: after, from: [labelText(category)], cells: countOf(column, category) }));
    } else if (hasTo && earlierCategories.has(`${after}\u0000${labelText(category)}\u0000${labelText(name)}`)) {
      rows.push(labelRow(kind, labelText(name), 'unchanged', { column: after, from: [labelText(category)] }));
    } else {
      rows.push(labelRow(kind, labelText(name), 'not-applied', { column: after, from: [labelText(category)], note: noCategoryNote(after, category) }));
    }
  }
  const replaced = new Map();
  // Each relabeled categorical's count of categories before, its first
  // category before a category after, and its categories after as labels
  // (a text column has none).
  const relabels = new Map();
  for (const [name, { column, renames }] of byColumn) {
    if (column.kind === 'categorical') {
      const made = renamedCategorical(column, renames);
      replaced.set(name, made.column);
      relabels.set(name, { before: column.categories.length, sources: made.sources, categories: made.labels });
    } else {
      replaced.set(name, renamedText(column, renames));
    }
  }
  for (const entry of overlays.deletedFields) rows.push(labelRow('field-deleted', entry.key, 'not-applied', { note: DELETION_NOTE }));
  return { rows, rename, replaced, relabels, renamed };
}

/**
 * Its colors go with a column, as Scanpy keeps them (`uns['<column>_colors']`),
 * by one rule, the same in cellucid-python (`anndata_session/_columns.py`
 * `write_columns`) and cellucid-r (`R/round-trip.R` `.colors_state`):
 *
 * - a column written (added or replaced) has the colors it is shown in (a
 *   categorical user field's: `shownCategoryColors`), and none otherwise:
 *   colors held under its name described another column;
 * - a column renamed takes its colors along when they are Scanpy's form, a
 *   list of text (colors of another form are removed: they cannot be carried);
 * - a categorical column relabeled in place keeps its colors when no
 *   categories merged; when some did, each category keeps the color of the
 *   first one it was made from (it takes that one's place), and colors that
 *   are not a list of text with one a category before are removed; a text
 *   column relabeled loses its colors (Scanpy colors a text column by its
 *   sorted labels, which a rename reorders);
 * - a dataset column the session recolored (`recolor`) takes the colors it
 *   is shown in (`planColumnColors`), after its renames.
 *
 * A column left as it is keeps its colors. The `uns` changes a copy writes
 * (`CopyChanges.uns`): each key to its colors, or null to remove one the
 * dataset holds.
 *
 * @param {CopyTarget} target
 * @param {{replaced: Map, relabels: Map, rename: Map}} labels - `planLabels`'
 * @param {Array<{name: string, colors: string[]|null}>} written - The columns written or replaced
 * @param {Map<string, string[]>} [recolor] - The dataset columns recolored, by their name after the renames
 * @returns {Promise<Record<string, string[]|null>>}
 */
async function colorChanges(target, labels, written, recolor = new Map()) {
  const changed = await nextColors(target, labels, written, recolor);
  const held = new Set(target.unsKeys);
  const uns = {};
  for (const [column, colors] of changed) {
    const key = `${column}_colors`;
    if (colors !== null) uns[key] = colors;
    else if (held.has(key)) uns[key] = null;
  }
  return uns;
}

/** A column's colors the dataset holds (`uns['<column>_colors']` as text), or null. */
async function heldColors(target, column) {
  if (!Array.isArray(target.unsKeys)) throw new TypeError('A copy target names its uns keys (unsKeys).');
  return target.unsKeys.includes(`${column}_colors`) ? target.colors(column) : null;
}

/** The colors `colorChanges` leaves, by column: each column whose colors change, to its colors or null (none). */
async function nextColors(target, labels, written, recolor) {
  const changed = new Map();
  const colorsOf = async column => (changed.has(column) ? changed.get(column) : heldColors(target, column));
  for (const name of labels.replaced.keys()) {
    const relabel = labels.relabels.get(name);
    if (relabel === undefined) {
      changed.set(name, null);
      continue;
    }
    if (relabel.sources.length === relabel.before) continue;
    const colors = await colorsOf(name);
    changed.set(name, colors === null || colors.length < relabel.before ? null : relabel.sources.map(at => colors[at]));
  }
  const moved = new Map();
  for (const old of labels.rename.keys()) moved.set(old, await colorsOf(old));
  for (const old of labels.rename.keys()) changed.set(old, null);
  for (const [old, name] of labels.rename) changed.set(name, moved.get(old));
  for (const [name, colors] of recolor) changed.set(name, [...colors]);
  for (const { name, colors } of written) changed.set(name, colors === null ? null : [...colors]);
  return changed;
}

// ---------------------------------------------------------------------------
// A dataset column the session recolored

/**
 * The colors the `count` categories of a dataset column open with in the
 * viewer from the colors Scanpy keeps for it (`held`, `uns['<column>_colors']`
 * as text): the first `count`, as drawn (`#rrggbb` in lowercase: `#rgb`
 * widened, the alpha of `#rrggbbaa` dropped), when there are that many and
 * each is a hex color `bytesOfHex` reads (`palettes.js`
 * `scanpyCategoryPalette`); null otherwise, and the column opens in
 * Cellucid's own colors by position. cellucid-python's `opening_palette`.
 *
 * @param {string[]|null} held
 * @param {number} count
 * @returns {string[]|null}
 */
export function openingPalette(held, count) {
  if (!Array.isArray(held) || count === 0 || held.length < count) return null;
  const out = [];
  for (let index = 0; index < count; index++) {
    const bytes = bytesOfHex(held[index]);
    if (bytes === null) return null;
    out.push(hexOfBytes(...bytes));
  }
  return out;
}

/**
 * Each dataset column the view in focus recolored categories of
 * (`focusedColumnRecolors`, by the key the dataset names it), with the
 * colors it is shown in: each category, in the column's order once the
 * apply's labels are applied, takes the color the person or an agent gave
 * it, else the color it opens with -- `openingPalette` of the colors held
 * for the column before the apply (a category merged by the apply takes its
 * first source's), else Cellucid's own colors by position. cellucid-python's
 * `plan_column_colors`, row for row.
 *
 * A row is `write` when those differ from the colors the column holds after
 * the apply's other changes, `unchanged` when they are the same,
 * `not-applied` (with the reason) for a column the dataset lacks, a MuData
 * modality's column, a column that is not categorical, or one with none of
 * the categories recolored.
 *
 * @param {Map<string, {colors: Map<string, string>, labels: Map<string, unknown>}>} recolored
 * @param {CopyTarget} target
 * @param {{replaced: Map, relabels: Map, rename: Map}} labels - `planLabels`'
 * @param {Map<string, string>} earlierNames - Columns earlier applies renamed, old name to new
 * @returns {Promise<{rows: object[], recolor: Map<string, string[]>}>}
 */
async function planColumnColors(recolored, target, labels, earlierNames) {
  const present = new Set(target.obsColumns);
  const wouldHold = await nextColors(target, labels, [], new Map());
  const rows = [];
  const recolor = new Map();
  const row = (name, status, note = null) => ({ kind: COLUMN_COLORS_KIND, domain: 'colors', name, column: null, from: [], cells: null, status, note });
  for (const [key, given] of recolored) {
    const before = present.has(key) ? key : earlierNames.get(key) ?? key;
    const after = labels.rename.get(before) ?? before;
    if (!present.has(before)) {
      rows.push(row(after, 'not-applied', target.modalityColumns.has(key) ? modalityColorsNote(key) : absentColumnNote(key)));
      continue;
    }
    const column = await target.column(before);
    if (column === null || column.kind !== 'categorical') {
      rows.push(row(after, 'not-applied', notCategoricalColorsNote(after)));
      continue;
    }
    const relabel = labels.relabels.get(before);
    const count = column.categories.length;
    const categories = relabel === undefined ? column.categories : relabel.categories;
    const sources = relabel === undefined ? categories.map((_, index) => index) : relabel.sources;
    const palette = openingPalette(await heldColors(target, before), count);
    const ids = categories.map(identity);
    const shown = ids.map((id, index) => given.colors.get(id)
      ?? (palette !== null ? palette[sources[index]] : hexOfRgb01(getCategoryColor(sources[index]))));
    const has = new Set(ids);
    const missing = [...given.colors.keys()].filter(id => !has.has(id)).map(id => labelText(given.labels.get(id)));
    if (missing.length === given.colors.size) {
      rows.push(row(after, 'not-applied', missingCategoriesNote(after, missing)));
      continue;
    }
    const note = missing.length > 0 ? missingCategoriesNote(after, missing) : null;
    const holds = wouldHold.has(after) ? wouldHold.get(after) : await heldColors(target, after);
    if (sameArray(holds, shown)) {
      rows.push(row(after, 'unchanged', note));
      continue;
    }
    recolor.set(after, shown);
    rows.push(row(after, 'write', note));
  }
  return { rows, recolor };
}

// ---------------------------------------------------------------------------
// User fields, highlights, gene sets

/**
 * Each field the view in focus at a step recolors categories of, in the
 * `colors` value's order: `{source, key, user, colors, labels}` (`user` null
 * for a dataset field, `key` null for a user field; `colors` each category's
 * identity to its `#rrggbb`, `labels` each identity to the label as held).
 * `colors` and `views` are the step's values (null when the session holds
 * none: nothing recolored, the live view in focus). cellucid-python
 * (`anndata_session/_colors.py` `_focused_entries`) and cellucid-r
 * (`.apply_focused_recolors`) read them by the same rule.
 */
function focusedEntries(colors, views) {
  const out = [];
  if (colors === null || colors === undefined) return out;
  const perView = colors.views;
  if (!Array.isArray(perView)) throw new TypeError("This session's colors value views must be a list.");
  const focus = views === null || views === undefined ? 0 : views.focus;
  if (!Number.isSafeInteger(focus) || focus < 0) throw new TypeError("This session's views value focus must be a non-negative whole number.");
  if (focus >= perView.length) throw new TypeError(`This session's colors value holds ${formatCountOf(perView.length, 'view')}, and the view in focus is view ${focus}.`);
  for (const entry of perView[focus]) {
    const field = entry?.field;
    const user = field?.user ?? null;
    const key = field?.key ?? null;
    if (user !== null ? typeof user !== 'string' || user === '' : typeof key !== 'string' || key === '') {
      throw new TypeError(`This session's colors value names a field without ${user !== null ? 'a user field id' : 'a key'}.`);
    }
    if (!Array.isArray(entry.colors)) continue;
    const recolored = new Map();
    const labels = new Map();
    for (const { category, color } of entry.colors) {
      if (typeof color !== 'string' || !HEX_COLOR.test(color)) throw new TypeError(`This session's colors value holds ${JSON.stringify(color)}, not one #rrggbb color.`);
      recolored.set(identity(category), color);
      if (!labels.has(identity(category))) labels.set(identity(category), category);
    }
    out.push({ source: field.source, key: user === null ? key : null, user, colors: recolored, labels });
  }
  return out;
}

/**
 * The categories of user fields recolored in the view in focus at a step:
 * by `<source>\u0000<field id>`, each category's identity to its `#rrggbb`
 * (`focusedEntries`).
 *
 * @param {unknown} colors - The `colors` value (`app/state/domains/colors.js`)
 * @param {unknown} views - The `views` value (`app/state/domains/views.js`)
 * @returns {Map<string, Map<string, string>>}
 */
export function focusedRecolors(colors, views) {
  return new Map(focusedEntries(colors, views).filter(entry => entry.user !== null)
    .map(entry => [`${entry.source}\u0000${entry.user}`, entry.colors]));
}

/**
 * The categories of the dataset's obs columns recolored in the view in focus
 * at a step, by the column's key as the dataset names it (a column renamed in
 * the session keeps its key), in the `colors` value's order. A gene's colors
 * (a color map, a range) are never categories: not here. cellucid-python's
 * `focused_column_recolors`.
 *
 * @param {unknown} colors
 * @param {unknown} views
 * @returns {Map<string, {colors: Map<string, string>, labels: Map<string, unknown>}>}
 */
export function focusedColumnRecolors(colors, views) {
  const out = new Map();
  for (const entry of focusedEntries(colors, views)) {
    if (entry.user === null && entry.source === 'obs' && entry.colors.size > 0) out.set(entry.key, { colors: entry.colors, labels: entry.labels });
  }
  return out;
}

/** One candidate column per user field: its values, or why the session does not apply it. */

/**
 * The colors a categorical user field's categories are shown in, one
 * `#rrggbb` a category in its order: the view in focus's recolors, else its
 * `palette`, else Cellucid's own colors by position.
 */
export function shownCategoryColors(field, recolored) {
  return field.categories.map((category, index) => recolored?.get(identity(category))
    ?? (Array.isArray(field.palette) ? field.palette[index] : hexOfRgb01(getCategoryColor(index))));
}

async function planUserFields(fields, target, nObs, unknown, recolors) {
  const candidates = [];
  for (const field of fields) {
    const unapplied = note => ({ kind: 'user-field', domain: 'field-overlays', name: field.key, column: null, cells: null, note });
    if (field.purged) {
      candidates.push(unapplied(PURGED_NOTE));
      continue;
    }
    if (field.deleted) {
      candidates.push(unapplied(DELETED_NOTE));
      continue;
    }
    let made;
    if (field.kind === 'category') {
      made = categoricalColumn(field, nObs, unknown);
    } else if (field.sourceField !== null && field.sourceField !== undefined) {
      // A continuous copy of another field: its values are that field's (as
      // the viewer reads them), known on the open cells.
      made = numbersColumn(await target.copiedValues(field), nObs, unknown);
    } else {
      made = numbersColumn(field.values, nObs, unknown);
    }
    // The colors a categorical field is shown in, written as `uns['<key>_colors']`.
    const recolored = recolors.get(`${field.source}\u0000${field.id}`);
    const colors = field.kind === 'category' ? shownCategoryColors(field, recolored) : null;
    candidates.push({
      kind: 'user-field', domain: 'field-overlays', name: field.key, column: made.column, cells: made.cells, note: null, colors,
      recolored: field.kind === 'category' && recolored !== undefined && recolored.size > 0,
    });
  }
  return candidates;
}

/** One candidate column per highlight group of every page. */
function planHighlights(highlights, nObs, unknown) {
  const taken = new Set();
  const candidates = [];
  for (const page of highlights.pages) {
    for (const group of page.groups) {
      const name = uniqueColumn(highlightColumn(page.name, page.id, group.label, group.id), taken);
      const made = membershipColumn(group.cells, nObs, unknown);
      candidates.push({ kind: 'highlight', domain: 'highlights', name, column: made.column, cells: made.cells, note: null });
    }
  }
  return candidates;
}

function geneSetRow(name, status, note = null) {
  return { kind: 'gene-set', domain: 'gene-sets', name, column: null, from: [], cells: null, status, note };
}

/**
 * Each gene set's var column, by name: `cellucid_gene_set__<name>` (the
 * highlight columns' rule: each run of non-ASCII-alphanumerics one `_`,
 * trimmed; `gene_set` when nothing is left), `_2`, `_3` on clashes, given
 * to every set of the step in its order, so a set's column is the same
 * whichever of them a copy writes.
 */
export function geneSetColumns(sets) {
  const taken = new Set();
  return new Map(sets.map(entry => [entry.name, uniqueColumn(`${GENE_SET_PREFIX}${columnPart(entry.name, 'gene_set')}`, taken)]));
}

/** A row per gene set of the step, and the entries to write. */
function planGeneSets(sets, current, overwrite) {
  const rows = [];
  const writes = new Map();
  for (const entry of sets) {
    const { name } = entry;
    const written = { genes: [...entry.genes], description: entry.description, origin: 'session', pulled_from: PULLED_FROM_VIEWER, id: name };
    const held = current?.[name];
    if (held === undefined || held === null) {
      writes.set(name, written);
      rows.push(geneSetRow(name, 'write'));
      continue;
    }
    const record = held !== null && typeof held === 'object' ? held : null;
    const same = record !== null && sameArray([...(record.genes ?? [])], written.genes) && record.description === written.description;
    const owned = record !== null && record.origin === 'session';
    if (same) rows.push(geneSetRow(name, 'unchanged'));
    else if (!owned) rows.push(geneSetRow(name, 'not-applied', takenSetNote(name)));
    else if (overwrite) {
      writes.set(name, written);
      rows.push(geneSetRow(name, 'replace', 'Written by an earlier apply; replaced.'));
    } else {
      rows.push(geneSetRow(name, 'not-applied', `An earlier apply wrote the gene set "${name}" with other genes; overwrite replaces it.`));
    }
  }
  return { rows, writes };
}

// ---------------------------------------------------------------------------
// What earlier applies wrote

/** Every apply recorded in a `uns['cellucid']` record (`history_applied`, JSON text), oldest first. */
export function historyApplied(record) {
  const text = record?.[HISTORY_APPLIED_KEY] ?? null;
  if (text === null) return [];
  if (typeof text !== 'string') throw new TypeError("This dataset's uns['cellucid']['history_applied'] must be JSON text (a list of apply records).");
  let entries;
  try {
    entries = JSON.parse(text);
  } catch {
    throw new TypeError("This dataset's uns['cellucid']['history_applied'] is not JSON.");
  }
  if (!Array.isArray(entries)) throw new TypeError("This dataset's uns['cellucid']['history_applied'] must be a list of apply records.");
  entries.forEach((entry, index) => validateRecord('Provenance', entry, `history_applied[${index}]`));
  return entries;
}

// ---------------------------------------------------------------------------
// The plan

/**
 * @typedef {Object} CopyTarget - The dataset a copy is planned against, as stored (every cell)
 * @property {number} nObs - Its cells
 * @property {string[]} obsColumns - Its obs columns, in order (a MuData's global obs)
 * @property {Set<string>} modalityColumns - Columns the viewer shows from a MuData's modalities (`<modality>:<key>`)
 * @property {(name: string) => Promise<Object|null>} column - One obs column over every cell by original position,
 *   as `element-writer.js` `column()` takes one (categories as the file stores them), or null
 * @property {string[]} unsKeys - Its root `uns` keys
 * @property {(name: string) => Promise<string[]|null>} colors - An obs column's colors, `uns['<name>_colors']`,
 *   when they are text (Scanpy's form), or null
 * @property {Object|null} cellucid - Its `uns['cellucid']` as plain values, or null
 * @property {Uint32Array|null} known - The cells the state is known on (the open cells of a subsample,
 *   ascending original positions); null for every cell
 * @property {(field: Object) => Promise<{cells: Uint32Array|null, values: Float32Array|Float64Array}>} copiedValues -
 *   A continuous copy's values, from the field it copies, on the known cells
 * @property {{names: string[], modality: string|null}|null} genes - The genes of the var frame the copy can
 *   change, one per var row, as the viewer names them (the data mapping's gene names); null when the
 *   mapping reads another axis (gene-set columns then go nowhere, said in `leftOut`)
 */

/**
 * The expression values a step's state holds, as the provenance records them
 * (the model's `ExpressionValues`): `{normalize, log1p}`, or null when the
 * session holds no `expression` value (a session from before them).
 *
 * @param {unknown} value - The step's `expression` value
 * @param {string} step
 * @returns {{normalize: boolean, log1p: boolean}|null}
 */
export function expressionValuesOf(value, step) {
  if (value === undefined || value === null) return null;
  const asked = requireExpressionTransform(value, `The expression values at step ${step}`);
  return { normalize: asked.normalize, log1p: asked.log1p };
}

/**
 * Plan one step of a tracker against a dataset, and the changes a copy
 * writes for it. Nothing is written; every check runs first.
 *
 * @param {Object} options
 * @param {{tracker: object, live: object, branch: string, step: string}} options.choice - `chooseStep`'s
 * @param {(domain: string) => unknown} options.valueOf - A domain's value at the chosen step
 * @param {CopyTarget} options.target
 * @param {string} options.sessionSha256 - The session file the provenance names
 * @param {string} options.version - Cellucid's version (the provenance's `cellucid_version`)
 * @param {string} [options.appliedAt] - When (canonical ISO time, UTC)
 * @param {boolean} [options.overwrite=false]
 * @returns {Promise<{plan: object, changes: object, provenance: object|null, leftOut: string[]}>}
 */
export async function planAnnDataCopy({ choice, valueOf, target, sessionSha256, version, appliedAt = new Date().toISOString(), overwrite = false }) {
  const { live, step } = choice;
  const hashes = valuesAt(live, step);
  const root = valuesAt(live, live.rootId);
  const nObs = target.nObs;
  const unknown = unknownMask(nObs, target.known);
  const requires = requiredFields(valueOf);
  const expression = expressionValuesOf(valueOf('expression'), step);

  const applied = historyApplied(target.cellucid);
  const owners = new Map();
  for (const record of applied) for (const column of record.columns) owners.set(column, record.step);
  const earlierRenames = applied.flatMap(record => record.renamed);

  const overlays = valueOf('field-overlays');
  const labels = await planLabels(overlays, target, earlierRenames);
  const presentAfter = new Set([...target.obsColumns.filter(name => !labels.rename.has(name)), ...labels.rename.values()]);
  const oldNameOf = new Map([...labels.rename].map(([from, to]) => [to, from]));

  const columns = [];
  // The columns written or replaced, with the colors each is shown in (`colorChanges`).
  const written = [];
  const settle = async candidate => {
    const { name } = candidate;
    const out = (status, note = candidate.note) => ({
      kind: candidate.kind, domain: candidate.domain, name, column: null, from: [], cells: candidate.cells, status, note,
    });
    if (candidate.column === null) return out('not-applied');
    if (!presentAfter.has(name)) {
      columns.push({ name, column: candidate.column });
      written.push({ name, colors: candidate.colors ?? null });
      return out('write');
    }
    if (!owners.has(name)) return out('not-applied', takenColumnNote(name));
    if (sameColumn(await target.column(oldNameOf.get(name) ?? name), candidate.column)) return out('unchanged');
    if (overwrite) {
      columns.push({ name, column: candidate.column });
      written.push({ name, colors: candidate.colors ?? null });
      return out('replace', `Written by an earlier apply (step ${owners.get(name)}); replaced.`);
    }
    return out('not-applied', ownedNote(name, owners.get(name)));
  };
  const fieldRows = [];
  const recolors = focusedRecolors(valueOf('colors') ?? null, valueOf('views') ?? null);
  // Whether a field written or replaced took colors the step's colors value gave it.
  let recoloredWritten = false;
  for (const candidate of await planUserFields(overlays.userFields, target, nObs, unknown, recolors)) {
    const row = await settle(candidate);
    if (candidate.recolored && (row.status === 'write' || row.status === 'replace')) recoloredWritten = true;
    fieldRows.push(row);
  }
  const currentSets = target.cellucid?.[GENE_SETS_KEY] ?? null;
  if (currentSets !== null && (typeof currentSets !== 'object' || Array.isArray(currentSets))) {
    throw new TypeError("This dataset's uns['cellucid']['gene_sets'] must be a mapping by gene-set name.");
  }
  const geneSets = planGeneSets(valueOf('gene-sets').sets, currentSets, overwrite);
  const highlightRows = [];
  for (const candidate of planHighlights(valueOf('highlights'), nObs, unknown)) highlightRows.push(await settle(candidate));
  const columnColors = await planColumnColors(focusedColumnRecolors(valueOf('colors') ?? null, valueOf('views') ?? null), target, labels,
    new Map(earlierRenames.filter(entry => entry.kind === 'column').map(entry => [entry.from, entry.to])));
  // Whether any colors went with a column: a field's, or a recolored dataset column's.
  const colorsWent = recoloredWritten || columnColors.rows.some(row => row.status !== 'not-applied');
  const presentation = domain => {
    if (DATA_DOMAINS.includes(domain) || hashes[domain] === root[domain]) return [];
    const note = domain === 'colors' && colorsWent ? COLORS_NOTE : PRESENTATION_NOTE;
    return [{ kind: 'presentation', domain, name: domainName(domain), column: null, from: [], cells: null, status: 'not-applied', note }];
  };
  const byDomain = new Map([
    ['field-overlays', [...labels.rows, ...fieldRows]],
    ['gene-sets', geneSets.rows],
    ['highlights', highlightRows],
  ]);
  if (columnColors.rows.length > 0) byDomain.set('colors', [...columnColors.rows, ...presentation('colors')]);
  const rows = DOMAIN_IDS.flatMap(domain => byDomain.get(domain) ?? presentation(domain));
  const plan = {
    session_sha256: sessionSha256,
    tracker: choice.tracker.id,
    branch: choice.branch,
    step,
    requires,
    rows,
  };
  validateRecord('ApplyPlan', plan, 'plan');
  const writesAnything = rows.some(row => row.status === 'write' || row.status === 'replace');

  // The changes a copy writes: relabeled and renamed columns in their
  // places, then the planned columns (replacing one of the same name).
  const obs = [];
  for (const [name, column] of labels.replaced) {
    const to = labels.rename.get(name);
    obs.push(to === undefined ? { name, column } : { name: to, from: name, column });
  }
  for (const [from, to] of labels.rename) if (!labels.replaced.has(from)) obs.push({ name: to, from, column: null });
  obs.push(...columns);

  const leftOut = [];
  const varChanges = [];
  if (geneSets.writes.size > 0) {
    if (target.genes === null) {
      leftOut.push('The gene sets are kept in uns[\'cellucid\'][\'gene_sets\'] only: the data mapping reads its genes from another matrix than var, so they have no var columns.');
    } else {
      const rowOf = new Map(target.genes.names.map((name, row) => [name, row]));
      const taken = new Set(target.genes.columns ?? []);
      const columnOf = geneSetColumns(valueOf('gene-sets').sets);
      for (const [name, entry] of geneSets.writes) {
        const column = columnOf.get(name);
        if (taken.has(column) && geneSets.rows.find(each => each.name === name)?.status !== 'replace') {
          leftOut.push(`The gene set "${name}" has no var column: the var column "${column}" is the dataset's own.`);
          continue;
        }
        const values = new Uint8Array(target.genes.names.length);
        const missing = [];
        for (const gene of entry.genes) {
          const row = rowOf.get(gene);
          if (row === undefined) missing.push(gene);
          else values[row] = 1;
        }
        if (missing.length > 0) leftOut.push(`The gene set "${name}" names ${formatCountOf(missing.length, 'gene')} the dataset does not have (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}), left out of its var column.`);
        varChanges.push({ name: column, column: { kind: 'booleans', values } });
      }
    }
  }

  let provenance = null;
  const cellucid = {};
  if (writesAnything) {
    provenance = {
      session_sha256: sessionSha256,
      tracker: plan.tracker,
      branch: plan.branch,
      step: plan.step,
      applied_at: appliedAt,
      cellucid_version: version,
      package: 'web',
      columns: rows.filter(row => (row.kind === 'user-field' || row.kind === 'highlight') && (row.status === 'write' || row.status === 'replace')).map(row => row.name),
      renamed: labels.renamed.map(entry => ({ ...entry })),
      skipped: rows.filter(row => row.status === 'not-applied').map(row => ({ kind: row.kind, name: row.name, note: row.note ?? '' })),
      expression,
      session: null,
    };
    validateRecord('Provenance', provenance, 'provenance');
    if (geneSets.writes.size > 0) cellucid[GENE_SETS_KEY] = { ...(currentSets ?? {}), ...Object.fromEntries(geneSets.writes) };
    cellucid[HISTORY_APPLIED_KEY] = JSON.stringify([...applied, provenance]);
  }
  const changes = { obs, var: varChanges };
  if (target.genes?.modality != null) changes.varModality = target.genes.modality;
  const uns = await colorChanges(target, labels, written, columnColors.recolor);
  if (Object.keys(uns).length > 0) changes.uns = uns;
  if (Object.keys(cellucid).length > 0) changes.cellucid = cellucid;
  return { plan, changes, provenance, leftOut };
}

/**
 * Where a name of a planned copy cannot be a path of a file (the portable
 * element-name rule, `data/anndata/write/names.js`), one plain sentence: a
 * gene set or a user-defined field with `/` in its name. Null when every
 * name can be written.
 *
 * @param {{rows: object[]}} plan
 * @param {(name: string, what: string) => void} requireName - `requireElementKey`
 */
export function unwritableName(plan, requireName) {
  for (const row of plan.rows) {
    if (!['write', 'replace'].includes(row.status) || !['gene-set', 'user-field'].includes(row.kind)) continue;
    try {
      requireName(row.name, row.kind === 'gene-set' ? 'The gene set' : 'The field');
    } catch {
      return row.kind === 'gene-set'
        ? `The gene set "${row.name}" cannot be saved in a file under that name (a / \\ < > : " | ? * or a name a file system reserves): rename it, then save the copy.`
        : `The field "${row.name}" cannot be saved in a file under that name (a / \\ < > : " | ? * or a name a file system reserves): rename it, then save the copy.`;
    }
  }
  return null;
}
