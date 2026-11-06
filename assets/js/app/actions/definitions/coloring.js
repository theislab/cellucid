/**
 * @fileoverview Actions on how the cells are coloured: by which field or
 * gene, a category's colour, and a continuous field's colour map, log scale,
 * gray for zero and colour range.
 *
 * They act on the view in focus, as the sidebar does. A continuous setting
 * names the field it is for, which must be the one the view is coloured by:
 * a step replayed where another field is shown is refused by name instead of
 * changing that one.
 *
 * @module app/actions/definitions/coloring
 */

import { defineAction } from '../catalog.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { CONTINUOUS_COLORMAPS } from '../../../data/palettes.js';
import {
  CATEGORY_FIELD, CATEGORY_LABEL, FIELD, COLOR, SHOWN_FIELD_READS, fieldArgument, fieldCoalesceKey, fieldWords,
} from './params.js';

export const COLORMAP_IDS = Object.freeze(CONTINUOUS_COLORMAPS.map(colormap => colormap.id));

const CONTINUOUS_FIELD = Object.freeze({
  ...FIELD,
  description: 'The continuous field or gene the view in focus is coloured by, by name.',
});

/** A switch of the shown field's colours: its name resolves in the shown field (context); `reads`, what it is computed from. */
function switchAction({ type, title, summary, word, code, reads = [], context = SHOWN_FIELD_READS }) {
  return defineAction({
    type,
    title,
    summary,
    group: 'Colours',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'enabled'],
      properties: { field: CONTINUOUS_FIELD, enabled: { type: 'boolean' } },
    },
    touches: ['colors'],
    reads,
    context,
    effect: 'view',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Turned ${word} ${p.enabled ? 'on' : 'off'} for ${fieldWords(p.field, quote)}`,
    code: p => `${code}(${fieldArgument(p.field)}, ${p.enabled ? 'True' : 'False'})`,
  });
}

export const coloringActions = Object.freeze([
  defineAction({
    type: 'color.by',
    title: 'Colour the cells by a field or gene',
    summary: 'Colour the view in focus by a column of the cells (source "obs") or a gene (source "var"), reading it first when needed; null clears the colouring.',
    group: 'Colours',
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: {
        field: {
          ...FIELD,
          type: ['object', 'null'],
          description: 'The field or gene by name; null colours the cells by nothing.',
        },
      },
    },
    touches: ['active-field', 'filters', 'colors'],
    reads: [],
    context: ['field-overlays', 'mapping', 'views'],
    effect: 'view',
    // A newer choice replaces one still being read.
    supersede: true,
    describe: (p, outcome, quote = PLAIN_QUOTE) => (p.field === null ? 'Cleared the colouring' : `Coloured by ${fieldWords(p.field, quote)}`),
    code: p => (p.field === null ? 'clear_color()' : `color_by(${fieldArgument(p.field)})`),
  }),
  defineAction({
    type: 'color.category',
    title: 'Colour one category',
    summary: 'Give one category of a categorical column another colour.',
    group: 'Colours',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'category', 'color'],
      properties: { field: CATEGORY_FIELD, category: CATEGORY_LABEL, color: COLOR },
    },
    touches: ['colors'],
    reads: [],
    context: ['field-overlays', 'views'],
    effect: 'view',
    // Dragging the colour picker is one step.
    coalesce: p => `${fieldCoalesceKey(p.field)}:${p.category}`,
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Coloured ${quote.bare(p.category)} of ${quote.bare(p.field.key)} ${p.color.toLowerCase()}`,
    code: p => `color_category(${JSON.stringify(p.field.key)}, ${JSON.stringify(p.category)}, ${JSON.stringify(p.color.toLowerCase())})`,
  }),
  defineAction({
    type: 'color.continuous.colormap',
    title: 'Choose a colour map',
    summary: 'The colour map a continuous field or gene is drawn with.',
    group: 'Colours',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'colormap'],
      properties: {
        field: CONTINUOUS_FIELD,
        colormap: { type: 'string', enum: [...COLORMAP_IDS], description: 'The colour map by its id (viridis, magma, coolwarm, …).' },
      },
    },
    touches: ['colors'],
    reads: [],
    context: SHOWN_FIELD_READS,
    effect: 'view',
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Drew ${fieldWords(p.field, quote)} in ${p.colormap}`,
    code: p => `colormap(${fieldArgument(p.field)}, ${JSON.stringify(p.colormap)})`,
  }),
  switchAction({
    type: 'color.continuous.log',
    title: 'Log colour scale',
    summary: 'Colour a continuous field or gene on a log scale, or a linear one.',
    word: 'the log colour scale',
    code: 'log_color_scale',
  }),
  switchAction({
    type: 'color.continuous.zero-gray',
    title: 'Gray for zero',
    summary: 'Draw a gene\'s zeros in gray beneath the expressing cells, or in the colour map\'s lowest colour.',
    word: 'gray for zero',
    code: 'gray_for_zero',
  }),
  switchAction({
    type: 'color.continuous.rescale',
    title: 'Rescale colours to the visible range',
    summary: 'Stretch the colour map over the visible range of a continuous field or gene, or over all its values.',
    word: 'rescaling to the visible range',
    code: 'rescale_colors',
    // Turned on, the colours span the visible range: the filter's, else the open cells' values.
    reads: ['filters', 'cells'],
    context: SHOWN_FIELD_READS,
  }),
  defineAction({
    type: 'color.continuous.range',
    title: 'Set the colour range',
    summary: 'The values the colour map spans for a continuous field or gene that is rescaled to a range.',
    group: 'Colours',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'min', 'max'],
      properties: { field: CONTINUOUS_FIELD, min: { type: 'number' }, max: { type: 'number' } },
    },
    touches: ['colors'],
    // Kept within the open cells' values.
    reads: [],
    context: [...SHOWN_FIELD_READS, 'cells'],
    effect: 'view',
    coalesce: p => fieldCoalesceKey(p.field),
    describe: (p, outcome, quote = PLAIN_QUOTE) => `Spanned the colours of ${fieldWords(p.field, quote)} over ${p.min}–${p.max}`,
    code: p => `color_range(${fieldArgument(p.field)}, ${p.min}, ${p.max})`,
  }),
]);
