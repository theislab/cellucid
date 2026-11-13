/**
 * @fileoverview View actions: keeping the selected view as a panel of the
 * multiview, removing views, the layout, which view is selected, linking
 * cameras, the embedding each view shows; and hiding cells one by one (the
 * cell visibility mask).
 *
 * A view is named `"View N"` as the Compare views list numbers its rows (the
 * live view, while shown, is View 1). A step replays the same sequence of
 * views, so it names the same view again (`app/actions/targets/views.js`, the
 * one owner of view names). A view can also be given a name of its own
 * (`view.rename`): a step's sentence says it beside the number
 * ('Selected View 2 "Early"', the outcome's `label`), and the view is still
 * addressed by its number.
 *
 * The implementations are `app/ui/modules/view-controls.js` (views and
 * `cells.visibility.set`) and `app/ui/modules/representation-controls.js`
 * (embeddings).
 *
 * @module app/actions/definitions/views
 */

import { defineAction } from '../catalog.js';
import { CELLS, EMBEDDING, VIEW, VIEW_NAME } from './params.js';
import { PER_VIEW_DOMAINS } from '../domains.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { viewWords } from '../targets/views.js';

const GROUP = 'Views';



const DIMENSION_PARAM = Object.freeze({ enum: [1, 2, 3], description: 'The dimension: 1, 2 or 3.' });

/**
 * A kept view carries its own coloring, filters, cell visibility and camera:
 * keeping or removing one changes each of those per-view domains.
 */
const VIEW_SET_TOUCHES = Object.freeze(['views', ...PER_VIEW_DOMAINS]);
/** What a view shows decides its navigation mode and its camera's dimension. */
const VIEW_SHOWS_TOUCHES = Object.freeze(['views', 'camera']);

function embeddingText(embedding) {
  return `obsm["${embedding.key}"] [${embedding.columns.join(', ')}]`;
}

export const viewActions = Object.freeze([
  defineAction({
    type: 'view.keep',
    title: 'Keep the view',
    // Version 2 adds the kept view's name; a version 1 step named none.
    version: 2,
    upgrade: { 1: params => params },
    summary: 'Freeze the selected view as a panel of the multiview, with its coloring, filters and camera, and select it; '
      + 'with a branch, the view as it is at the last step of that branch of the history (to compare branches side by side).',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        branch: {
          type: 'string', minLength: 1,
          description: 'A branch of the tracker in use, by its name: the kept view shows what the selected view shows at its last step (coloring, filters, hidden cells, camera).',
          examples: ['Main'],
        },
        name: { ...VIEW_NAME, description: `The kept view's name (view_rename gives or changes one later). ${VIEW_NAME.description}` },
      },
    },
    touches: VIEW_SET_TOUCHES,
    // With a branch, that branch's last step.
    reads: ['history'],
    effect: 'view',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Kept the view${params.branch === undefined ? '' : ` of branch ${quote(params.branch)}`}`
      + `${outcome?.view === undefined ? (params.name === undefined ? '' : ` as ${quote(params.name)}`) : ` as ${viewWords(outcome.view, params.name, quote)}`}`,
    code: params => {
      const args = [
        ...(params.branch === undefined ? [] : [`branch=${JSON.stringify(params.branch)}`]),
        ...(params.name === undefined ? [] : [`name=${JSON.stringify(params.name)}`]),
      ];
      return `keep_view(${args.join(', ')})`;
    },
  }),
  defineAction({
    type: 'view.remove',
    title: 'Remove a view',
    summary: 'Remove a view: a kept view is deleted; the live view (View 1) is hidden and every kept view stays. '
      + 'The last open view cannot be removed; view_clear shows the live view again.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['view'],
      properties: { view: VIEW },
    },
    touches: VIEW_SET_TOUCHES,
    reads: [],
    effect: 'view',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Removed ${viewWords(params.view, outcome?.label, quote)}`,
    code: params => `remove_view(${JSON.stringify(params.view)})`,
  }),
  defineAction({
    type: 'view.rename',
    title: 'Name a view',
    summary: 'Give a view a name of its own, or take it away (null): its row and its pane show it beside its number, a figure\'s '
      + 'panel title after the panel\'s letter ("B. Early"). The view is still named "View N" in actions.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['view', 'name'],
      properties: {
        view: VIEW,
        name: { oneOf: [VIEW_NAME, { type: 'null', description: 'No name: the view is known by its number alone.' }], description: 'The new name, or null for none.' },
      },
    },
    touches: ['views'],
    reads: [],
    effect: 'view',
    // Typing a name and correcting it is one step per view.
    coalesce: params => params.view,
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.name === null
      ? `Took the name off ${viewWords(params.view, outcome?.was ?? null, quote)}`
      : `Named ${quote.bare(params.view)} ${quote(params.name)}`),
    code: params => `rename_view(${JSON.stringify(params.view)}, ${params.name === null ? 'None' : JSON.stringify(params.name)})`,
  }),
  defineAction({
    type: 'view.clear',
    title: 'Remove every kept view',
    summary: 'Remove every kept view and show the live view alone (as View 1).',
    group: GROUP,
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: VIEW_SET_TOUCHES,
    reads: [],
    effect: 'view',
    describe: (params, outcome) => (
      `Removed every kept view${outcome?.views === undefined ? '' : ` (${formatCountOf(outcome.views, 'view')})`}`
    ),
    code: () => 'clear_views()',
  }),
  defineAction({
    type: 'view.layout.set',
    title: 'Set the view layout',
    summary: 'Show every view side by side (grid) or the selected view alone (single).',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['layout'],
      properties: { layout: { enum: ['grid', 'single'], description: '"grid" or "single".' } },
    },
    touches: ['views'],
    reads: [],
    effect: 'view',
    describe: params => (params.layout === 'grid' ? 'Showed the views side by side' : 'Showed the selected view alone'),
    code: params => `set_view_layout(${JSON.stringify(params.layout)})`,
  }),
  defineAction({
    type: 'view.focus',
    title: 'Select a view',
    summary: 'Select the view the sidebar edits and the camera controls drive.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['view'],
      properties: { view: VIEW },
    },
    // The navigation mode shown is the selected view's.
    touches: VIEW_SHOWS_TOUCHES,
    reads: [],
    effect: 'view',
    // Clicking through panes is one step.
    coalesce: () => 'focus',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Selected ${viewWords(params.view, outcome?.label, quote)}`,
    code: params => `select_view(${JSON.stringify(params.view)})`,
  }),
  defineAction({
    type: 'view.cameras.link',
    title: 'Link cameras',
    summary: 'Let views that show the same embedding share one camera, or give each view its own.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['linked'],
      properties: { linked: { type: 'boolean', description: 'true to link, false to unlink.' } },
    },
    // Linking gives the linked views one camera.
    touches: VIEW_SHOWS_TOUCHES,
    reads: [],
    effect: 'view',
    describe: params => (params.linked ? 'Linked the cameras of views of one embedding' : 'Gave each view its own camera'),
    code: params => `link_cameras(${params.linked ? 'True' : 'False'})`,
  }),
  defineAction({
    type: 'view.embedding.set',
    title: 'Show an embedding',
    summary: 'Show one enabled embedding in a view; the view keeps it when the data mapping changes its defaults.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['view', 'embedding'],
      properties: { view: VIEW, embedding: EMBEDDING },
    },
    touches: VIEW_SHOWS_TOUCHES,
    // The embeddings the data mapping enables.
    reads: [],
    context: ['mapping'],
    effect: 'view',
    supersede: true,
    // As the picker names it ("UMAP · 2D", the outcome's), else by its obsm key and columns.
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Showed ${quote.bare(outcome?.embedding ?? embeddingText(params.embedding))} in ${viewWords(params.view, outcome?.label, quote)}`,
    code: params => `show_embedding(${JSON.stringify(params.view)}, ${JSON.stringify(params.embedding.key)}, [${params.embedding.columns.join(', ')}])`,
  }),
  defineAction({
    type: 'view.embedding.default',
    title: 'Show the default embedding',
    summary: 'Show the dataset\'s default embedding of one dimension in a view; the view follows that default from then on.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['view', 'dimension'],
      properties: { view: VIEW, dimension: DIMENSION_PARAM },
    },
    touches: VIEW_SHOWS_TOUCHES,
    reads: [],
    context: ['mapping'],
    effect: 'view',
    supersede: true,
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Showed the ${params.dimension}D default${outcome?.embedding === undefined ? '' : ` (${quote.bare(outcome.embedding)})`} in ${viewWords(params.view, outcome?.label, quote)}`,
    code: params => `show_default_embedding(${JSON.stringify(params.view)}, ${params.dimension})`,
  }),
  defineAction({
    type: 'view.embedding.cycle',
    title: 'Next embedding of a dimension',
    summary: 'The 1, 2 and 3 keys: a view showing another dimension shows this dimension\'s default; one already showing it moves to the next enabled embedding.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['view', 'dimension'],
      properties: { view: VIEW, dimension: DIMENSION_PARAM },
    },
    touches: VIEW_SHOWS_TOUCHES,
    reads: [],
    context: ['mapping'],
    effect: 'view',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Showed ${outcome?.embedding === undefined ? `the next ${params.dimension}D embedding` : quote.bare(outcome.embedding)} in ${viewWords(params.view, outcome?.label, quote)}`,
    code: params => `next_embedding(${JSON.stringify(params.view)}, ${params.dimension})`,
  }),
  defineAction({
    type: 'cells.visibility.set',
    title: 'Hide or show cells',
    summary: 'Hide or show cells one by one in the selected view, on top of every filter.',
    group: 'Cells',
    params: {
      type: 'object', additionalProperties: false, required: ['cells', 'visible'],
      properties: {
        cells: {
          oneOf: [CELLS, { type: 'null', description: 'Every cell.' }],
          description: 'Cells by original position, or null for every cell.',
        },
        visible: { type: 'boolean', description: 'true to show them, false to hide them.' },
      },
    },
    touches: ['visibility'],
    // The view in focus; cells not open are left out.
    reads: [],
    context: ['views', 'cells'],
    effect: 'state',
    describe: (params, outcome) => {
      const count = outcome?.cells ?? (params.cells === null ? null : params.cells.length);
      return `${params.visible ? 'Showed' : 'Hid'} ${params.cells === null ? 'every cell' : formatCountOf(count, 'cell')}`;
    },
    code: params => `set_visibility(${params.cells === null ? 'None' : `<${formatCountOf(params.cells.length, 'cell')}>`}, visible=${params.visible ? 'True' : 'False'})`,
  }),
]);
