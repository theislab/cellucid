/**
 * @fileoverview Highlight actions: highlight pages (make, show, rename,
 * recolour, delete, combine, clear) and the groups of cells on them (a
 * confirmed selection, a category, a range of values; show or hide one,
 * remove one).
 *
 * A page and a group are named by their names as the Highlighting panel
 * shows them; cells by original position (their row of `obs`), so a step
 * replays on a subsample or on another dataset with the same names. A page's
 * colour is the colour the page has everywhere it is drawn (its tab, the
 * analyses that compare pages, the category builder); a highlight never
 * recolours a page it did not make (`highlight.cells` `color`).
 *
 * The implementation is `app/ui/modules/highlight/highlight-actions.js`.
 *
 * @module app/actions/definitions/highlights
 */

import { defineAction } from '../catalog.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { CATEGORY_LABEL, CELLS, COLOR, FIELD, PAGE, TRIMMED_NAME, VISIBLE_CELLS_READS } from './params.js';

const GROUP = 'Highlights';
const TOUCHES = Object.freeze(['highlights']);





/** Where the cells of a new group go, shared by the three ways to make one. */
const TARGET_PROPERTIES = Object.freeze({
  page: {
    ...PAGE,
    description: 'The page the group goes on, by name; a page of that name is made when there is none. Omitted: the page shown, or with `color`, a page of that colour.',
  },
  color: {
    ...COLOR,
    description: 'The colour of the page the group goes on. With `page`, the colour of the page made (an existing page must already have it). Without, the page shown when it has this colour, else the first page that has it, else a new page of it.',
  },
});

const GROUP_PARAM = Object.freeze({
  type: 'string', minLength: 1, pattern: TRIMMED_NAME,
  description: 'A highlight group, by its label as the group list shows it (without the cell count).',
});

/** The page part of a sentence: "" for the page shown, ` on page "X"` otherwise. */
function onPage(params, quote) {
  return params.page === undefined ? '' : ` on page ${quote(params.page)}`;
}

function quoted(text) {
  return JSON.stringify(String(text));
}

function cellCount(params, outcome) {
  return outcome?.cells ?? params.cells?.length ?? null;
}

export const highlightActions = Object.freeze([
  defineAction({
    type: 'highlight.page.create',
    title: 'Make a highlight page',
    summary: 'Add an empty highlight page and show it.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { ...PAGE, description: 'The new page\'s name; omitted, the first free "Page N".' },
        color: { ...COLOR, description: 'The new page\'s colour; omitted, the next colour of the page palette.' },
      },
    },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Made highlight page ${quote(outcome?.page ?? params.name ?? 'new')}`,
    code: params => `create_highlight_page(${params.name === undefined ? '' : quoted(params.name)}${params.color === undefined ? '' : `, color=${quoted(params.color)}`})`,
  }),
  defineAction({
    type: 'highlight.page.switch',
    title: 'Show a highlight page',
    summary: 'Show another highlight page: its groups are the highlighted cells.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['page'],
      properties: { page: PAGE },
    },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Showed highlight page ${quote(params.page)}`,
    code: params => `show_highlight_page(${quoted(params.page)})`,
  }),
  defineAction({
    type: 'highlight.page.rename',
    title: 'Rename a highlight page',
    summary: 'Give a highlight page another name, unique among the pages.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['page', 'name'],
      properties: { page: PAGE, name: { ...PAGE, description: 'The new name.' } },
    },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Renamed highlight page ${quote(params.page)} to ${quote(params.name)}`,
    code: params => `rename_highlight_page(${quoted(params.page)}, ${quoted(params.name)})`,
  }),
  defineAction({
    type: 'highlight.page.recolor',
    title: 'Recolour a highlight page',
    summary: 'Set the colour a highlight page has in its tab, the analyses and the category builder.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['page', 'color'],
      properties: { page: PAGE, color: COLOR },
    },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    // A colour picker drag is one step per page.
    coalesce: params => params.page,
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Recoloured highlight page ${quote(params.page)} ${params.color}`,
    code: params => `set_highlight_page_color(${quoted(params.page)}, ${quoted(params.color)})`,
  }),
  defineAction({
    type: 'highlight.page.delete',
    title: 'Delete a highlight page',
    summary: 'Delete a highlight page and its groups; the last page cannot be deleted.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['page'],
      properties: { page: PAGE },
    },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Deleted highlight page ${quote(params.page)}`,
    code: params => `delete_highlight_page(${quoted(params.page)})`,
  }),
  defineAction({
    type: 'highlight.page.combine',
    title: 'Combine two highlight pages',
    summary: 'Make a page of the cells in both pages (intersection) or in either (union), and show it.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['pages', 'operation'],
      properties: {
        pages: {
          type: 'array', items: PAGE, minItems: 2, maxItems: 2, uniqueItems: true,
          description: 'The two pages, by name.',
          examples: [['Page 1', 'Page 2']],
        },
        operation: { enum: ['intersection', 'union'], description: 'Cells in both pages, or in either.' },
        name: { ...PAGE, description: 'The new page\'s name; omitted, "A ∩ B" or "A ∪ B".' },
      },
    },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => {
      const [a, b] = params.pages;
      const made = outcome?.page === undefined ? '' : ` as ${quote(outcome.page)}`;
      return `${params.operation === 'intersection' ? 'Intersected' : 'United'} highlight pages ${quote(a)} and ${quote(b)}${made}`;
    },
    code: params => `combine_highlight_pages(${quoted(params.pages[0])}, ${quoted(params.pages[1])}, ${quoted(params.operation)}${params.name === undefined ? '' : `, name=${quoted(params.name)}`})`,
  }),
  defineAction({
    type: 'highlight.page.clear',
    title: 'Clear a highlight page',
    summary: 'Remove every group of one highlight page; the page stays.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false,
      properties: { page: { ...PAGE, description: 'The page, by name; omitted, the page shown.' } },
    },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => (
      `Cleared highlight page${params.page === undefined ? '' : ` ${quote(params.page)}`}` +
      (outcome?.groups === undefined ? '' : ` (${formatCountOf(outcome.groups, 'group')})`)
    ),
    code: params => `clear_highlight_page(${params.page === undefined ? '' : quoted(params.page)})`,
  }),
  defineAction({
    type: 'highlight.clear-all',
    title: 'Clear every highlight',
    summary: 'Remove every group of every highlight page; the pages stay.',
    group: GROUP,
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    describe: (params, outcome) => (
      `Cleared every highlight${outcome?.groups === undefined ? '' : ` (${formatCountOf(outcome.groups, 'group')})`}`
    ),
    code: () => 'clear_highlights()',
  }),
  defineAction({
    type: 'highlight.cells',
    title: 'Highlight cells',
    summary: 'Add a group of cells to a highlight page: a confirmed selection, or cells an agent or notebook names.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['cells'],
      properties: {
        cells: CELLS,
        label: { ...GROUP_PARAM, description: 'The group\'s label; omitted, "Highlight (N cells)". A label already on the page gets " (2)", " (3)", ….' },
        tool: {
          enum: ['annotation', 'lasso', 'proximity', 'knn'],
          default: 'annotation',
          description: 'The selection tool that made the cells (annotation for cells named directly).',
        },
        ...TARGET_PROPERTIES,
      },
    },
    touches: TOUCHES,
    reads: [],
    context: ['cells'],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => {
      const count = cellCount(params, outcome);
      const name = outcome?.group ?? params.label;
      return `Highlighted ${count === null ? 'cells' : formatCountOf(count, 'cell')}` +
        `${name === undefined ? '' : ` as ${quote(name)}`}${outcome?.page === undefined ? onPage(params, quote) : ` on page ${quote(outcome.page)}`}`;
    },
    code: params => (
      `highlight_cells(<${formatCountOf(params.cells.length, 'cell')}>` +
      `${params.label === undefined ? '' : `, label=${quoted(params.label)}`}` +
      `${params.page === undefined ? '' : `, page=${quoted(params.page)}`}` +
      `${params.color === undefined ? '' : `, color=${quoted(params.color)}`})`
    ),
  }),
  defineAction({
    type: 'highlight.category',
    title: 'Highlight a category',
    summary: 'Add the cells of one category of a field, as the selected view shows them, as a group.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'category'],
      properties: {
        field: { ...FIELD, description: 'A categorical field, by name.' },
        // A category label (`CATEGORY_LABEL`'s examples: a replay's name mapping finds it, `replay.js`).
        category: {
          type: ['string', 'number', 'boolean'],
          description: 'The category, by its label as the legend shows it.',
          examples: CATEGORY_LABEL.examples,
        },
        ...TARGET_PROPERTIES,
      },
    },
    touches: TOUCHES,
    reads: VISIBLE_CELLS_READS,
    rerun: true,
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => (
      `${outcome?.updated === true ? 'Updated the cells of' : 'Highlighted'} ${quote(params.category)} of ${quote.bare(params.field.key)}` +
      `${outcome?.cells === undefined ? '' : ` (${formatCountOf(outcome.cells, 'cell')})`}${onPage(params, quote)}`
    ),
    code: params => `highlight_category(${quoted(params.field.key)}, ${quoted(params.category)}${params.page === undefined ? '' : `, page=${quoted(params.page)}`})`,
  }),
  defineAction({
    type: 'highlight.range',
    title: 'Highlight a range of values',
    summary: 'Add the cells whose value of a continuous field or gene lies in a range, as the selected view shows them, as a group.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'min', 'max'],
      properties: {
        field: { ...FIELD, description: 'A continuous field or a gene, by name.' },
        min: { type: 'number', description: 'The smallest value included.' },
        max: { type: 'number', description: 'The largest value included.' },
        ...TARGET_PROPERTIES,
      },
    },
    touches: TOUCHES,
    reads: VISIBLE_CELLS_READS,
    rerun: true,
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => (
      `${outcome?.updated === true ? 'Updated the cells of' : 'Highlighted'} ${quote.bare(params.field.key)} from ${params.min} to ${params.max}` +
      `${outcome?.cells === undefined ? '' : ` (${formatCountOf(outcome.cells, 'cell')})`}${onPage(params, quote)}`
    ),
    code: params => `highlight_range(${quoted(params.field.key)}, ${params.min}, ${params.max}${params.page === undefined ? '' : `, page=${quoted(params.page)}`})`,
  }),
  defineAction({
    type: 'highlight.group.toggle',
    title: 'Show or hide a highlight group',
    summary: 'Turn one group of a page on or off; a group that is off highlights nothing.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['group', 'enabled'],
      properties: {
        group: GROUP_PARAM,
        enabled: { type: 'boolean', description: 'true to show the group, false to hide it.' },
        page: { ...PAGE, description: 'The group\'s page, by name; omitted, the page shown.' },
      },
    },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `${params.enabled ? 'Showed' : 'Hid'} highlight ${quote(params.group)}${onPage(params, quote)}`,
    code: params => `set_highlight_enabled(${quoted(params.group)}, ${params.enabled ? 'True' : 'False'}${params.page === undefined ? '' : `, page=${quoted(params.page)}`})`,
  }),
  defineAction({
    type: 'highlight.group.remove',
    title: 'Remove a highlight group',
    summary: 'Remove one group from a highlight page.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['group'],
      properties: {
        group: GROUP_PARAM,
        page: { ...PAGE, description: 'The group\'s page, by name; omitted, the page shown.' },
      },
    },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Removed highlight ${quote(params.group)}${onPage(params, quote)}`,
    code: params => `remove_highlight(${quoted(params.group)}${params.page === undefined ? '' : `, page=${quoted(params.page)}`})`,
  }),
]);
