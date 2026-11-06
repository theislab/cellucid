/**
 * @fileoverview Settings: every stable control of the sidebar (render,
 * navigation, overlays, cell info, the selection tool), one generic action.
 *
 * The settings are the control inventory of `state-serializer/ui-controls.js`
 * (`controlDomainOf`: everything but the layout's and the views' controls),
 * read from the markup: a control added to `index.html` is a setting the
 * agent can list and set, the history records and a session saves, with no
 * code here. A person's change is recorded by observation
 * (`ui/modules/settings-actions.js`); an agent, a host or a replay sets one
 * through `setting.set`, which sets the control and dispatches its event, the
 * path a session restore takes.
 *
 * The Figure export panel's settings are one record of the same domain
 * (`exportSessionSettings`: a frame drawn on the preview and a title that
 * follows the dataset are no control's value), set by `figure-export.set`,
 * whose parameters are that record's settings
 * (`ui/modules/figure-export/utils/session-settings.js`); a person's change
 * is recorded by observation there too.
 *
 * @module app/actions/definitions/settings
 */

import { defineAction } from '../catalog.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { FIGURE_EXPORT_PARAMS } from '../../ui/modules/figure-export/utils/session-settings.js';

/** A figure-export parameter's value as a timeline label shows it ("preview enabled on, colorblind mode none"). */
function figureValueWords(value, quote, nested = false) {
  if (value === null) return 'none';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'object') {
    if (nested) return 'set';
    return Object.entries(value).map(([key, item]) => `${key.replaceAll('_', ' ')} ${figureValueWords(item, quote, true)}`).join(', ');
  }
  return typeof value === 'string' ? quote.bare(value) : String(value);
}

const SETTING_KINDS = Object.freeze(['number', 'count', 'switch', 'choice', 'colour', 'text']);

/** A setting value as a timeline label shows it. */
function shownValue(params, outcome, quote) {
  if (typeof outcome?.shown === 'string' && outcome.shown.length > 0) return quote.bare(outcome.shown);
  return typeof params.value === 'string' ? quote(params.value) : String(params.value);
}

/** One setting as `settings.list` gives it (`describeSetting` in ui-controls.js). */
export const SETTING_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['id', 'label', 'section', 'kind', 'value', 'available'],
  properties: {
    id: { type: 'string', description: 'What setting.set names it by.' },
    label: { type: 'string', description: 'Its name in the sidebar.' },
    section: { type: ['string', 'null'], description: 'The sidebar section it is in.' },
    kind: { type: 'string', enum: [...SETTING_KINDS], description: 'number (a slider or box), count (a whole number of at least 1), switch, choice, colour (#rrggbb) or text.' },
    value: { type: ['string', 'number', 'boolean'], description: 'Its value now, as setting.set takes it.' },
    shown: { type: 'string', description: 'What the sidebar shows for the value (a slider\'s position is not always the value it means).' },
    min: { type: 'number' },
    max: { type: 'number' },
    step: { type: 'number' },
    options: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['value', 'label'],
        properties: { value: { type: 'string' }, label: { type: 'string' } },
      },
    },
    available: { type: 'boolean', description: 'False while another setting switches it off.' },
  },
});

export const settingsActions = Object.freeze([
  defineAction({
    type: 'setting.set',
    title: 'Change a setting',
    summary: 'Set one render, navigation, overlay or tool setting of the sidebar; settings.list names each, with its kind, range and choices.',
    group: 'Settings',
    params: {
      type: 'object', additionalProperties: false, required: ['setting', 'value'],
      properties: {
        setting: {
          type: 'string', minLength: 1,
          description: 'The setting\'s id, as settings.list gives it.',
          examples: ['point-size'],
        },
        value: {
          type: ['string', 'number', 'boolean'],
          description: 'A number for a slider, true or false for a switch, an option value for a choice, #rrggbb for a colour.',
          examples: [20],
        },
      },
    },
    // A setting is the settings domain's; the render mode also decides the
    // view layout (Smoke shows one view), which is the views'.
    touches: ['settings', 'views'],
    // A vector-field setting's choices are the mapping's vector fields of the embedding shown.
    reads: [],
    context: ['mapping'],
    effect: 'view',
    // A slider dragged, a box typed into: one step per setting while it is
    // the last thing changed.
    coalesce: params => params.setting,
    describe: (params, outcome, quote = PLAIN_QUOTE) => {
      const label = quote.bare(typeof outcome?.label === 'string' ? outcome.label : params.setting);
      if (typeof params.value === 'boolean') return `${label}: turned ${params.value ? 'on' : 'off'}`;
      return `${label}: set to ${shownValue(params, outcome, quote)}`;
    },
    code: params => `set_setting(${JSON.stringify(params.setting)}, ${JSON.stringify(params.value)})`,
  }),
  defineAction({
    type: 'figure-export.set',
    title: 'Change figure export settings',
    summary: 'Set Figure export options: size, frame, background, fonts, title and axis labels, axes, legend, preview, what Export downloads; only those given change, nothing is exported.',
    group: 'Settings',
    // The panel's settings are one record of the settings domain
    // (`exportSessionSettings`), not controls of the generic inventory: a
    // frame drawn on the preview and a title that follows the dataset are
    // no control's value. A person's change is recorded by observation
    // (`figure-export-ui.js`).
    params: FIGURE_EXPORT_PARAMS,
    touches: ['settings'],
    reads: [],
    effect: 'view',
    // A width typed, a frame dragged, a title typed: one step while the same options change.
    coalesce: params => Object.keys(params).sort().join(','),
    describe: (params, outcome, quote = PLAIN_QUOTE) => {
      const parts = Object.entries(params).map(([key, value]) => `${key.replaceAll('_', ' ')} ${figureValueWords(value, quote)}`);
      return `Figure export: ${parts.length === 0 ? 'unchanged' : parts.join(', ')}`;
    },
    code: params => `set_figure_export(${Object.entries(params).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')})`,
  }),
  defineAction({
    type: 'settings.list',
    title: 'List the settings',
    summary: 'Every setting of the sidebar with its label, section, kind, value, range or choices, and whether it can be changed now.',
    group: 'Settings',
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        section: {
          type: 'string', minLength: 1,
          description: 'Only the settings of the sidebar section with this title (Visualization, Navigation, …).',
        },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['settings'],
      properties: { settings: { type: 'array', items: SETTING_SCHEMA } },
    },
    describe: () => 'Read the settings',
    code: params => (params.section === undefined ? 'list_settings()' : `list_settings(section=${JSON.stringify(params.section)})`),
  }),
]);
