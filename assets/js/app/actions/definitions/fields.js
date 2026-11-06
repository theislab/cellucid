/**
 * @fileoverview Actions on fields and their labels: rename a field or put
 * its name back, delete, restore and purge it, duplicate it, make a field
 * from highlight pages, take a column a notebook pushes, build the community
 * annotation's consensus column, rename, merge and delete categories, and
 * keep a gene set.
 *
 * Every field, category, page and gene is named, never placed: a step
 * replays on another dataset that has the same names. The implementations
 * are the state's (`app/state/field-actions/`) and the field selector's
 * (duplicating shows the copy, as the toolbar does).
 *
 * `touches` lists every domain a handler can change. A field's name is how
 * the other domains name it (the colouring, its filters and colours, a
 * category highlight's label, a view's label), so a rename or a delete
 * touches those too.
 *
 * @module app/actions/definitions/fields
 */

import { defineAction, valuesOnlyUpgrade } from '../catalog.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { CATEGORY_FIELD, CATEGORY_LABEL, FIELD, fieldArgument, fieldWords } from './params.js';

/** What a category of an annotated column came to: an agreed label, or none yet. */
export const CONSENSUS_STATUSES = Object.freeze(['consensus', 'disputed', 'pending']);

const NAME = Object.freeze({
  type: 'string',
  minLength: 1,
  description: 'A field name: not empty, unique among the fields shown.',
});

/** What a field's name reaches besides the field itself. */
const NAMED_FIELD_DOMAINS = ['field-overlays', 'active-field', 'filters', 'colors', 'highlights', 'views'];

const OVERLAP_STRATEGIES = Object.freeze(['first', 'last', 'overlap-label', 'intersections']);

export const fieldActions = Object.freeze([
  defineAction({
    type: 'field.rename',
    title: 'Rename a field',
    summary: 'Give a column of the cells or a gene another name; its original name stays known, and renaming it back to that name restores it.',
    group: 'Fields',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'name'],
      properties: { field: FIELD, name: NAME },
    },
    touches: NAMED_FIELD_DOMAINS,
    // A gene is named by the mapping's gene names.
    reads: [],
    context: ['mapping'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Renamed ${fieldWords(p.field, quote)} to ${quote.bare(p.name)}`,
    code: p => `rename_field(${fieldArgument(p.field)}, ${JSON.stringify(p.name)})`,
  }),
  defineAction({
    type: 'field.revert-name',
    title: 'Restore a field\'s original name',
    summary: 'Give a renamed field back the name it has in the file.',
    group: 'Fields',
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: { field: FIELD },
    },
    touches: NAMED_FIELD_DOMAINS,
    reads: [],
    context: ['mapping'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => (typeof outcome?.name === 'string'
      ? `Renamed ${fieldWords(p.field, quote)} back to ${quote.bare(outcome.name)}`
      : `Restored the original name of ${fieldWords(p.field, quote)}`),
    code: p => `revert_field_name(${fieldArgument(p.field)})`,
  }),
  defineAction({
    type: 'field.delete',
    title: 'Delete a field',
    summary: 'Remove a column of the cells or a gene from the lists; it can be restored from Deleted fields until purged.',
    group: 'Fields',
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: { field: FIELD },
    },
    touches: NAMED_FIELD_DOMAINS,
    reads: [],
    context: ['mapping'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Deleted ${fieldWords(p.field, quote)}`,
    code: p => `delete_field(${fieldArgument(p.field)})`,
  }),
  defineAction({
    type: 'field.restore',
    title: 'Restore a deleted field',
    summary: 'Bring back a deleted field under its name, as it was when deleted.',
    group: 'Fields',
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: { field: { ...FIELD, description: 'The deleted field by the name it had when deleted.' } },
    },
    touches: NAMED_FIELD_DOMAINS,
    reads: [],
    context: ['mapping'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Restored ${fieldWords(p.field, quote)}`,
    code: p => `restore_field(${fieldArgument(p.field)})`,
  }),
  defineAction({
    type: 'field.purge',
    title: 'Purge a deleted field',
    summary: 'Confirm a deletion: the field leaves Deleted fields and can no longer be restored there (undo still brings it back).',
    group: 'Fields',
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: { field: { ...FIELD, description: 'The deleted field by the name it had when deleted.' } },
    },
    touches: ['field-overlays', 'filters'],
    reads: [],
    context: ['mapping'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Purged ${fieldWords(p.field, quote)}`,
    code: p => `purge_field(${fieldArgument(p.field)})`,
  }),
  defineAction({
    type: 'field.duplicate',
    title: 'Duplicate a field',
    summary: 'Copy a column of the cells or a gene as a new field (named "<name> (copy)" unless a name is given) and colour by the copy.',
    group: 'Fields',
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: {
        field: FIELD,
        name: { ...NAME, description: 'The copy\'s name; by default "<name> (copy)", numbered when taken.' },
      },
    },
    touches: NAMED_FIELD_DOMAINS,
    // The copy holds the open cells' values (a gene's, read with the mapping).
    reads: ['mapping', 'cells'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Duplicated ${fieldWords(p.field, quote)} as ${quote.bare(outcome?.name ?? p.name ?? `${p.field.key} (copy)`)}`,
    code: p => `duplicate_field(${fieldArgument(p.field)}${p.name === undefined ? '' : `, name=${JSON.stringify(p.name)}`})`,
  }),
  defineAction({
    type: 'field.create-from-pages',
    title: 'Make a field from highlight pages',
    summary: 'A new categorical column whose categories are highlight pages: each page\'s cells take its label; cells on several pages follow the overlap rule.',
    group: 'Fields',
    params: {
      type: 'object', additionalProperties: false, required: ['key', 'pages'],
      properties: {
        key: { ...NAME, description: 'The new column\'s name.' },
        pages: {
          type: 'array', minItems: 1, description: 'The pages, in order (first and last refer to it), each with its category label.',
          items: {
            type: 'object', additionalProperties: false, required: ['page', 'label'],
            properties: {
              page: { type: 'string', minLength: 1, description: 'A highlight page by name.' },
              label: { ...CATEGORY_LABEL, description: 'The category its cells take.' },
            },
          },
        },
        uncovered_label: { type: 'string', default: 'Unassigned', description: 'The category of cells on no page; empty leaves them without one.' },
        overlap: {
          type: 'string', enum: [...OVERLAP_STRATEGIES], default: 'first',
          description: 'Cells on several pages: the first page\'s label, the last\'s, the overlap label, or one label per combination of pages.',
        },
        overlap_label: { type: 'string', default: 'Overlap', description: 'The label of cells on several pages when overlap is "overlap-label".' },
        intersection_labels: {
          type: 'array', default: [], description: 'With overlap "intersections": the label of each combination of pages that has cells.',
          items: {
            type: 'object', additionalProperties: false, required: ['pages', 'label'],
            properties: {
              pages: { type: 'array', minItems: 2, uniqueItems: true, items: { type: 'string', minLength: 1 }, description: 'The pages of the combination, by name.' },
              label: CATEGORY_LABEL,
            },
          },
        },
      },
    },
    touches: ['field-overlays'],
    // Its categories are the pages' cells; the open cells outside them are uncovered.
    reads: ['highlights', 'cells'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Made ${quote.bare(p.key)} from ${formatCountOf(p.pages.length, 'highlight page')}`,
    code: p => `field_from_pages(${JSON.stringify(p.key)}, {${p.pages.map(e => `${JSON.stringify(e.page)}: ${JSON.stringify(e.label)}`).join(', ')}}${p.overlap === undefined ? '' : `, overlap=${JSON.stringify(p.overlap)}`})`,
  }),
  defineAction({
    type: 'field.push',
    title: 'Add a column of values',
    summary: 'A notebook\'s column as a field of the cells: categorical (codes into its categories) or continuous; a later push of the same name replaces it.',
    group: 'Fields',
    params: {
      type: 'object', additionalProperties: false, required: ['key', 'kind', 'categories', 'n_obs', 'cells', 'values'],
      properties: {
        key: { ...NAME, description: 'The column\'s name.' },
        kind: { type: 'string', enum: ['categorical', 'continuous'] },
        categories: {
          type: ['array', 'null'], items: { type: 'string' },
          description: 'A categorical column\'s categories (its values are codes into them; the largest code is "no category"); null for a continuous one.',
        },
        n_obs: { type: 'integer', minimum: 0, description: 'The cells of the dataset the column belongs to.' },
        cells: {
          type: ['array', 'null'], items: { type: 'integer', minimum: 0 }, 'x-cells': true,
          description: 'The cells the values are of, as original positions; null for every cell in order.',
        },
        values: {
          type: 'array', items: { type: 'number' }, 'x-values': true,
          description: 'One value per cell named: a code (categorical) or a number (continuous).',
        },
      },
    },
    touches: ['field-overlays', 'active-field', 'filters', 'colors'],
    reads: [],
    context: ['cells'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Added the ${p.kind} column ${quote.bare(p.key)}`,
    code: p => `push_column(${JSON.stringify(p.key)}, kind=${JSON.stringify(p.kind)})`,
  }),
  defineAction({
    type: 'field.consensus',
    title: 'Build the consensus column',
    summary: 'The community annotation\'s consensus for a categorical column as a column of its own: each cell gets the agreed label of its category, or the status of a category without one (disputed, pending); built again under the same name, it is replaced. The outcome of each category is named in the parameters, so it replays by name on any dataset with the same column and categories.',
    group: 'Fields',
    version: 2,
    // Version 1 named one consensus code per cell (the column as built), not
    // the outcome of each category: what a cell's category was is not in it,
    // so no parameters of version 2 can be made from it. Its steps put their
    // values back on the dataset they were built on, and are flagged on another.
    upgrade: {
      1: valuesOnlyUpgrade('It was built by an earlier Cellucid as one value per cell, so it is not applied again by name; on the dataset it was built on its values are put back. Build the consensus column again here.'),
    },
    params: {
      type: 'object', additionalProperties: false, required: ['key', 'field', 'mapping', 'settings', 'provenance'],
      properties: {
        key: { ...NAME, description: 'The consensus column\'s name.' },
        field: { ...CATEGORY_FIELD, description: 'The annotated column the consensus is of.' },
        mapping: {
          type: 'array', minItems: 1,
          description: 'The outcome of each category of the column (a category left out is pending).',
          items: {
            type: 'object', additionalProperties: false, required: ['category', 'status', 'label', 'voters'],
            properties: {
              category: { ...CATEGORY_LABEL, description: 'A category of the annotated column as the legend shows it.' },
              status: { type: 'string', enum: [...CONSENSUS_STATUSES], description: 'consensus (its cells get the agreed label), disputed or pending.' },
              label: { type: ['string', 'null'], minLength: 1, description: 'The agreed label (written by the community: data); null unless the status is consensus.' },
              voters: { type: 'integer', minimum: 0, description: 'How many people voted on its suggestions.' },
            },
          },
        },
        settings: {
          type: 'object', additionalProperties: false, required: ['minAnnotators', 'threshold'],
          description: 'The consensus rule it was built with.',
          properties: {
            minAnnotators: { type: 'integer', minimum: 0, description: 'Voters a category needs before it can agree.' },
            threshold: { type: 'number', minimum: -1, maximum: 1, description: 'The net share of votes the leading label needs (-1 to 1).' },
          },
        },
        provenance: {
          type: 'object', additionalProperties: false, required: ['repository', 'branch', 'commit', 'pulledAt'],
          description: 'Where the votes came from.',
          properties: {
            repository: { type: ['string', 'null'], minLength: 1, description: 'The GitHub repository (owner/name), null when none was connected.' },
            branch: { type: ['string', 'null'], minLength: 1, description: 'Its branch, when known.' },
            commit: { type: ['string', 'null'], minLength: 1, description: 'The commit pulled, when known.' },
            pulledAt: { type: ['string', 'null'], minLength: 1, description: 'When it was last pulled (ISO 8601), null when never.' },
          },
        },
      },
    },
    touches: ['field-overlays', 'active-field', 'filters', 'colors'],
    reads: [],
    context: ['cells'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Built the consensus column ${quote.bare(p.key)} of ${quote.bare(p.field.key)}`,
    code: p => `consensus_column(${JSON.stringify(p.key)}, of=${JSON.stringify(p.field.key)}, mapping={${p.mapping.map(e => `${JSON.stringify(e.category)}: ${JSON.stringify(e.status === 'consensus' ? e.label : e.status)}`).join(', ')}})`,
  }),
  defineAction({
    type: 'category.rename',
    title: 'Rename a category',
    summary: 'Give one category of a categorical column another label; its original label stays known.',
    group: 'Fields',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'category', 'name'],
      properties: {
        field: CATEGORY_FIELD,
        category: CATEGORY_LABEL,
        name: { ...CATEGORY_LABEL, description: 'The new label, unique in the column.' },
      },
    },
    touches: ['field-overlays', 'filters', 'colors', 'highlights', 'views'],
    reads: [],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Renamed ${quote.bare(p.category)} to ${quote.bare(p.name)} in ${quote.bare(p.field.key)}`,
    code: p => `rename_category(${JSON.stringify(p.field.key)}, ${JSON.stringify(p.category)}, ${JSON.stringify(p.name)})`,
  }),
  defineAction({
    type: 'category.merge',
    title: 'Merge two categories',
    summary: 'Move every cell of one category into another. A column from the file becomes a new column (the original moves to Deleted fields); a column made in the app is edited in place.',
    group: 'Fields',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'category', 'into'],
      properties: {
        field: CATEGORY_FIELD,
        category: { ...CATEGORY_LABEL, description: 'The category whose cells move.' },
        into: { ...CATEGORY_LABEL, description: 'The category they join.' },
      },
    },
    touches: NAMED_FIELD_DOMAINS,
    reads: [],
    context: ['cells'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Merged ${quote.bare(p.category)} into ${quote.bare(p.into)} in ${quote.bare(p.field.key)}`,
    code: p => `merge_categories(${JSON.stringify(p.field.key)}, ${JSON.stringify(p.category)}, into=${JSON.stringify(p.into)})`,
  }),
  defineAction({
    type: 'category.delete',
    title: 'Delete a category',
    summary: 'Move every cell of one category into the unassigned category. A column from the file becomes a new column (the original moves to Deleted fields); a column made in the app is edited in place.',
    group: 'Fields',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'category'],
      properties: {
        field: CATEGORY_FIELD,
        category: CATEGORY_LABEL,
        unassigned_label: { ...CATEGORY_LABEL, default: 'unassigned', description: 'The category the cells move into, made when missing.' },
      },
    },
    touches: NAMED_FIELD_DOMAINS,
    reads: [],
    context: ['cells'],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Deleted the category ${quote.bare(p.category)} of ${quote.bare(p.field.key)}`,
    code: p => `delete_category(${JSON.stringify(p.field.key)}, ${JSON.stringify(p.category)})`,
  }),
  defineAction({
    type: 'gene-set.save',
    title: 'Keep a gene set',
    summary: 'A named list of genes, kept with the dataset for analyses and sessions; a later set of the same name replaces it.',
    group: 'Genes',
    params: {
      type: 'object', additionalProperties: false, required: ['name', 'genes'],
      properties: {
        name: { type: 'string', minLength: 1, description: 'The set\'s name.' },
        description: { type: 'string', default: '', description: 'What the set is.' },
        genes: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Gene names.' },
      },
    },
    touches: ['gene-sets'],
    reads: [],
    effect: 'state',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Kept the gene set ${quote.bare(p.name)} (${formatCountOf(p.genes.length, 'gene')})`,
    code: p => `gene_set(${JSON.stringify(p.name)}, [${p.genes.slice(0, 5).map(g => JSON.stringify(g)).join(', ')}${p.genes.length > 5 ? ', …' : ''}])`,
  }),
]);
