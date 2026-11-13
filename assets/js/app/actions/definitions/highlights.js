/**
 * @fileoverview Highlight actions: highlight pages (make, show, rename,
 * recolor, delete, combine, clear) and the groups of cells on them (a
 * confirmed selection, a category, a range of values; show or hide one,
 * remove one).
 *
 * A page and a group are named by their names as the Highlighting panel
 * shows them; cells by original position (their row of `obs`), so a step
 * replays on a subsample or on another dataset with the same names. A page's
 * color is the color the page has everywhere it is drawn (its tab, the
 * analyses that compare pages, the category builder); a highlight never
 * recolors a page it did not make (`highlight.cells` `color`).
 *
 * The implementation is `app/ui/modules/highlight/highlight-actions.js`.
 *
 * @module app/actions/definitions/highlights
 */

import { defineAction } from '../catalog.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { PLAIN_QUOTE, categoryLabel } from '../targets/names.js';
import { CATEGORY_LABEL, CELLS, COLOR, FIELD, PAGE, TRIMMED_NAME, VISIBLE_CELLS_READS, categoriesWords } from './params.js';

const GROUP = 'Highlights';
const TOUCHES = Object.freeze(['highlights']);





/** Where the cells of a new group go, shared by the three ways to make one. */
const TARGET_PROPERTIES = Object.freeze({
  page: {
    ...PAGE,
    description: 'The page the group goes on, by name; a page of that name is made when there is none. Omitted: the page shown, or with `color`, a page of that color.',
  },
  color: {
    ...COLOR,
    description: 'The color of the page the group goes on. With `page`, the color of the page made (an existing page must already have it). Without, the page shown when it has this color, else the first page that has it, else a new page of it.',
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

/** Page names for a step's label: the first three, then how many more. */
function pageNames(pages, quote) {
  const shown = pages.slice(0, 3).map(name => quote(name)).join(', ');
  return pages.length > 3 ? `${shown} and ${pages.length - 3} more` : shown;
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
        color: { ...COLOR, description: 'The new page\'s color; omitted, the next color of the page palette.' },
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
      properties: { page: PAGE, name: { ...PAGE, examples: ['Progenitors'], description: 'The new name.' } },
    },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Renamed highlight page ${quote(params.page)} to ${quote(params.name)}`,
    code: params => `rename_highlight_page(${quoted(params.page)}, ${quoted(params.name)})`,
  }),
  defineAction({
    type: 'highlight.page.recolor',
    title: 'Recolor a highlight page',
    summary: 'Set the color a highlight page has in its tab, the analyses and the category builder.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['page', 'color'],
      properties: { page: PAGE, color: COLOR },
    },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    // A color picker drag is one step per page.
    coalesce: params => params.page,
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Recolored highlight page ${quote(params.page)} ${params.color}`,
    code: params => `set_highlight_page_color(${quoted(params.page)}, ${quoted(params.color)})`,
  }),
  defineAction({
    type: 'highlight.page.delete',
    title: 'Delete highlight pages',
    summary: 'Delete one or several highlight pages and their groups, as one step; at least one page stays.',
    group: GROUP,
    // Version 2 deletes several pages at once, so clearing the pages an agent made is one call,
    // not one per page; a version-1 step named one page.
    version: 2,
    upgrade: { 1: ({ page }) => ({ pages: [page] }) },
    params: {
      type: 'object', additionalProperties: false, required: ['pages'],
      properties: {
        pages: {
          type: 'array', items: PAGE, minItems: 1, uniqueItems: true,
          description: 'The pages to delete, by name; at least one page stays (clear the last one instead).',
          examples: [['Page 2'], ['tmp 1', 'tmp 2']],
        },
      },
    },
    touches: TOUCHES,
    reads: [],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.pages.length === 1
      ? `Deleted highlight page ${quote(params.pages[0])}`
      : `Deleted ${formatCountOf(params.pages.length, 'highlight page')}: ${pageNames(params.pages, quote)}`),
    code: params => `delete_highlight_pages([${params.pages.map(quoted).join(', ')}])`,
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
        label: { ...GROUP_PARAM, description: 'The group\'s label; omitted, "Highlight" (the list shows its cell count). A label already on the page gets " (2)", " (3)", ….' },
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
    title: 'Highlight categories',
    summary: 'Add the cells of one or more categories of a field, as the selected view shows them, each category as a group of its own, in one step.',
    group: GROUP,
    // Version 2 names several categories (`categories`) where version 1 named
    // one (`category`): one act, one step, one undo for a page of ten donors.
    // A label is the text the legend shows: a version-1 step named a category by its raw
    // value (a number or a boolean), which version 2 turns into that text.
    version: 2,
    upgrade: { 1: ({ category, ...rest }) => ({ ...rest, categories: [categoryLabel(category)] }) },
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'categories'],
      properties: {
        field: { ...FIELD, description: 'A categorical field, by name.' },
        categories: {
          type: 'array', minItems: 1, uniqueItems: true,
          // A category label (`CATEGORY_LABEL`, whose examples a replay's name mapping finds, `replay.js`).
          items: { ...CATEGORY_LABEL, description: 'A category, by its label as the legend shows it (a number or a boolean category as its text: "3", "true").' },
          description: 'The categories, by their labels as the legend shows them: each becomes a group of the page, all in one step. One already on the page is brought up to the cells the view shows now.',
          examples: [['T cells'], ['donor 1', 'donor 2', 'donor 3']],
        },
        ...TARGET_PROPERTIES,
      },
    },
    touches: TOUCHES,
    reads: VISIBLE_CELLS_READS,
    rerun: true,
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => {
      // What the step did: the categories it added or brought up to date (the
      // outcome's), else, before it ran, the categories asked for.
      const labels = outcome?.categories ?? params.categories;
      const updated = outcome?.updated ?? 0;
      const verb = updated > 0 && updated === labels.length ? 'Updated the cells of' : 'Highlighted';
      const some = updated > 0 && updated < labels.length ? `, ${updated} of them brought up to date` : '';
      // Each label in quotes, as one category was named ("T cells" of cell_type); past three, a count.
      const inQuotes = Object.assign(name => quote(name), { bare: quote });
      return `${verb} ${categoriesWords(labels, inQuotes)} of ${quote.bare(params.field.key)}` +
        `${outcome?.cells === undefined ? '' : ` (${formatCountOf(outcome.cells, 'cell')})`}${onPage(params, quote)}${some}`;
    },
    code: params => (
      `highlight_category(${quoted(params.field.key)}, [${params.categories.map(quoted).join(', ')}]` +
      `${params.page === undefined ? '' : `, page=${quoted(params.page)}`})`
    ),
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
