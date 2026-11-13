/**
 * @fileoverview Layout: the sidebar's sections docked or floating, where a
 * floating one stands, which sections are open, the sidebar shown or hidden
 * and its width, and the theme.
 *
 * A section is named by its title as the sidebar shows it ("Visualization")
 * or by its id. The owners provide the implementations: the dockable panels
 * (`app/dockable-accordions.js`: float, dock, dock all, place; their buttons dispatch,
 * a drag or a resize is recorded when it ends), the sidebar
 * (`ui/modules/sidebar-controls.js`: shown, width), the sections and the
 * theme (`ui/modules/layout-actions.js`, recorded by observation of the
 * control a person used). Floating analysis windows are the analysis's
 * (`definitions/analysis.js`).
 *
 * Page chrome is no action: the phone sheet opening and
 * closing, the sidebar's scroll and focus, which panel is in front. On the
 * phone layout `layout.sidebar.show` sets whether the sidebar shows beside
 * the plot on a wider window, and leaves the sheet as it is.
 *
 * @module app/actions/definitions/layout
 */

import { defineAction } from '../catalog.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { PLAIN_QUOTE } from '../targets/names.js';

const PANEL = Object.freeze({
  type: 'string', minLength: 1,
  description: 'A sidebar section by its title (Visualization, Navigation, …) or its id.',
  examples: ['Visualization'],
});

const PIXELS = description => ({ type: 'number', description });

const RECT_PROPERTIES = Object.freeze({
  left: PIXELS('Distance of its left edge from the left of the window, in CSS pixels.'),
  top: PIXELS('Distance of its top edge from the top of the window, in CSS pixels.'),
  width: { type: 'number', exclusiveMinimum: 0, description: 'Width in CSS pixels (kept at least its smallest working width).' },
  height: { type: 'number', exclusiveMinimum: 0, description: 'Height in CSS pixels (kept at least its header and first row).' },
});

/** A box as a timeline reads it. */
function boxText({ left, top, width, height }) {
  return `${Math.round(width)} × ${Math.round(height)} at ${Math.round(left)}, ${Math.round(top)}`;
}

/** The panel's title as the handler resolved it, else the name it was given. */
function panelName(params, outcome, quote) {
  return quote.bare(typeof outcome?.panel === 'string' ? outcome.panel : params.panel);
}

const PANEL_RESULT = Object.freeze({
  type: 'object', additionalProperties: false, required: ['id', 'title', 'floating', 'open'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    floating: { type: 'boolean' },
    open: { type: 'boolean' },
    left: { type: 'number' },
    top: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
  },
});

export const layoutActions = Object.freeze([
  defineAction({
    type: 'layout.panel.float',
    title: 'Undock a section',
    summary: 'Tear a sidebar section off into a floating window, at a given place and size or beside the sidebar.',
    group: 'Layout',
    params: {
      type: 'object', additionalProperties: false, required: ['panel'],
      properties: { panel: PANEL, ...RECT_PROPERTIES },
    },
    touches: ['layout'],
    reads: [],
    effect: 'layout',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Undocked ${panelName(params, outcome, quote)}`,
    code: params => `float_panel(${JSON.stringify(params.panel)}${params.left === undefined ? ''
      : `, left=${params.left}, top=${params.top}, width=${params.width}, height=${params.height}`})`,
  }),
  defineAction({
    type: 'layout.panel.dock',
    title: 'Dock a section',
    summary: 'Put a floating sidebar section back into the sidebar, where it was.',
    group: 'Layout',
    params: {
      type: 'object', additionalProperties: false, required: ['panel'],
      properties: { panel: PANEL },
    },
    touches: ['layout'],
    reads: [],
    effect: 'layout',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Docked ${panelName(params, outcome, quote)}`,
    code: params => `dock_panel(${JSON.stringify(params.panel)})`,
  }),
  defineAction({
    type: 'layout.panel.dock-all',
    title: 'Dock every section',
    summary: 'Put every floating sidebar section back into the sidebar, each where it was (the sidebar\'s Dock all button).',
    group: 'Layout',
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: ['layout'],
    reads: [],
    effect: 'layout',
    describe: (params, outcome) => (Array.isArray(outcome?.panels)
      ? `Docked ${formatCountOf(outcome.panels.length, 'section')}`
      : 'Docked every section'),
    code: () => 'dock_all_panels()',
  }),
  defineAction({
    type: 'layout.panel.place',
    title: 'Move or resize a floating section',
    summary: 'Give a floating sidebar section a place and size; it is kept inside the window.',
    group: 'Layout',
    params: {
      type: 'object', additionalProperties: false, required: ['panel', 'left', 'top', 'width', 'height'],
      properties: { panel: PANEL, ...RECT_PROPERTIES },
    },
    touches: ['layout'],
    reads: [],
    effect: 'layout',
    // A drag, a resize, arrow keys: one step per panel while it is the last
    // thing moved.
    coalesce: params => params.panel,
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Moved ${panelName(params, outcome, quote)} to ${boxText(params)}`,
    code: params => `place_panel(${JSON.stringify(params.panel)}, left=${params.left}, top=${params.top}, width=${params.width}, height=${params.height})`,
  }),
  defineAction({
    type: 'layout.section.open',
    title: 'Open or close a section',
    summary: 'Open or close a section of the sidebar (docked or floating).',
    group: 'Layout',
    params: {
      type: 'object', additionalProperties: false, required: ['section', 'open'],
      properties: {
        section: PANEL,
        open: { type: 'boolean', description: 'True opens it, false closes it.' },
      },
    },
    touches: ['layout'],
    reads: [],
    effect: 'layout',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `${params.open ? 'Opened' : 'Closed'} ${quote.bare(typeof outcome?.panel === 'string' ? outcome.panel : params.section)}`,
    code: params => `open_section(${JSON.stringify(params.section)}, ${params.open ? 'True' : 'False'})`,
  }),
  defineAction({
    type: 'layout.sidebar.show',
    title: 'Show or hide the sidebar',
    summary: 'Show the sidebar beside the plot, or hide it to give the plot the whole window.',
    group: 'Layout',
    params: {
      type: 'object', additionalProperties: false, required: ['shown'],
      properties: { shown: { type: 'boolean', description: 'True shows the sidebar, false hides it.' } },
    },
    touches: ['layout'],
    reads: [],
    effect: 'layout',
    describe: params => (params.shown ? 'Showed the sidebar' : 'Hid the sidebar'),
    code: params => `show_sidebar(${params.shown ? 'True' : 'False'})`,
  }),
  defineAction({
    type: 'layout.sidebar.width',
    title: 'Resize the sidebar',
    summary: 'Set the sidebar\'s width (kept between its narrowest and widest).',
    group: 'Layout',
    params: {
      type: 'object', additionalProperties: false, required: ['width'],
      properties: { width: { type: 'number', exclusiveMinimum: 0, description: 'Width in CSS pixels.' } },
    },
    touches: ['layout'],
    reads: [],
    effect: 'layout',
    coalesce: () => 'sidebar',
    describe: params => `Made the sidebar ${formatCountOf(Math.round(params.width), 'pixel')} wide`,
    code: params => `sidebar_width(${params.width})`,
  }),
  defineAction({
    type: 'layout.theme.set',
    title: 'Choose the theme',
    summary: 'Show the app light or dark.',
    group: 'Layout',
    params: {
      type: 'object', additionalProperties: false, required: ['theme'],
      properties: { theme: { type: 'string', enum: ['light', 'dark'] } },
    },
    // A viewer background never chosen follows the theme (`render-controls.js`
    // `followTheme`): the step holds that change of the settings too.
    touches: ['layout', 'settings'],
    reads: [],
    effect: 'layout',
    describe: params => `Chose the ${params.theme} theme`,
    code: params => `set_theme(${JSON.stringify(params.theme)})`,
  }),
  defineAction({
    type: 'layout.get',
    title: 'Read the layout',
    summary: 'The sidebar\'s sections (docked or floating, where, open or closed), whether the sidebar shows and how wide, and the theme.',
    group: 'Layout',
    params: { type: 'object', additionalProperties: false, properties: {} },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['panels', 'sidebar', 'theme'],
      properties: {
        panels: { type: 'array', items: PANEL_RESULT },
        sidebar: {
          type: 'object', additionalProperties: false, required: ['shown', 'width'],
          properties: { shown: { type: 'boolean' }, width: { type: 'number' } },
        },
        theme: { type: 'string', enum: ['light', 'dark'] },
      },
    },
    describe: () => 'Read the layout',
    code: () => 'get_layout()',
  }),
]);
