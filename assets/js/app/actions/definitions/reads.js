/**
 * @fileoverview What an agent, a notebook or a test reads of the open
 * dataset: compact JSON (counts, names, top-N tables with N a parameter),
 * never whole per-cell arrays except for the cells asked for by position.
 * Reads change nothing and record no step. The handlers are `app/reads/`.
 *
 * Fields are named `{source, key}`: an `obs` field (a cell annotation) by its
 * key as the sidebar shows it, a gene (`var`) by its name as shown. Cells are
 * original positions (the row of the cell in the file's `obs`).
 *
 * @module app/actions/definitions/reads
 */

import { defineAction } from '../catalog.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { FIELD, VIEW } from './params.js';


const NO_PARAMS = Object.freeze({ type: 'object', additionalProperties: false, properties: {} });
const COUNT = Object.freeze({ type: 'integer', minimum: 0 });
const TOP = description => ({ type: 'integer', minimum: 1, default: 50, description });

const CAMERA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['navigationMode', 'orbit', 'freefly'],
  properties: {
    navigationMode: { type: 'string', enum: ['orbit', 'planar', 'free'] },
    orbit: {
      type: 'object', additionalProperties: false, required: ['radius', 'targetRadius', 'theta', 'phi', 'target'],
      properties: {
        radius: { type: 'number' }, targetRadius: { type: 'number' }, theta: { type: 'number' }, phi: { type: 'number' },
        target: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      },
    },
    freefly: {
      type: 'object', additionalProperties: false, required: ['position', 'yaw', 'pitch'],
      properties: {
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        yaw: { type: 'number' }, pitch: { type: 'number' },
      },
    },
  },
});

const FIELD_RESULT = Object.freeze({
  type: 'object', additionalProperties: false, required: ['source', 'key', 'kind'],
  properties: {
    source: { type: 'string', enum: ['obs', 'var'] },
    key: { type: 'string' },
    kind: { type: 'string', enum: ['categorical', 'continuous'] },
  },
});

export const readActions = Object.freeze([
  defineAction({
    type: 'dataset.summary',
    title: 'Read the dataset summary',
    summary: 'The open dataset: its name, citation, how many cells (and how many are open), genes, embeddings and fields.',
    group: 'Dataset',
    params: NO_PARAMS,
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false,
      required: ['name', 'id', 'source', 'citation', 'cells', 'genes', 'embeddings', 'fields'],
      properties: {
        name: { type: ['string', 'null'] },
        id: { type: ['string', 'null'], description: 'The dataset\'s id where it has one.' },
        source: { type: ['string', 'null'], description: 'Where it was opened from (a sample, a link, a local file, a notebook).' },
        citation: { type: ['string', 'null'] },
        cells: {
          type: 'object', additionalProperties: false, required: ['total', 'open', 'share', 'subsample', 'digest'],
          properties: {
            total: COUNT,
            open: COUNT,
            share: { type: 'number', description: 'open / total.' },
            subsample: { type: ['string', 'null'], description: 'How the open cells were chosen, when they are a subsample.' },
            digest: { type: 'string', description: 'Names the open cells: equal digests, same cells.' },
          },
        },
        genes: {
          type: 'object', additionalProperties: false, required: ['count', 'read_for'],
          properties: {
            count: COUNT,
            read_for: {
              type: ['object', 'null'], additionalProperties: false, required: ['cells', 'of'],
              description: 'The open cells a gene is read for, when not every open cell (Genes read for).',
              properties: { cells: COUNT, of: COUNT },
            },
          },
        },
        embeddings: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['name', 'dimension'],
            properties: { name: { type: 'string' }, dimension: { type: 'integer', minimum: 1 } },
          },
        },
        fields: {
          type: 'object', additionalProperties: false, required: ['categorical', 'continuous', 'user_defined'],
          properties: { categorical: COUNT, continuous: COUNT, user_defined: COUNT },
        },
      },
    },
    describe: () => 'Read the dataset summary',
    code: () => 'dataset_summary()',
  }),
  defineAction({
    type: 'fields.list',
    title: 'List the fields',
    summary: 'The cell annotations (obs fields) with their kind and, for a categorical one, how many categories it has.',
    group: 'Dataset',
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['categorical', 'continuous'], description: 'Only fields of this kind.' },
        query: { type: 'string', minLength: 1, description: 'Only fields whose key contains this text (any case).' },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['fields'],
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['key', 'kind', 'user_defined'],
            properties: {
              key: { type: 'string' },
              kind: { type: 'string', enum: ['categorical', 'continuous'] },
              categories: { ...COUNT, description: 'How many categories, when they are known before the field is read.' },
              user_defined: { type: 'boolean', description: 'Made in the app (an annotation field), not in the file.' },
            },
          },
        },
      },
    },
    describe: () => 'Listed the fields',
    code: params => `list_fields(${params.kind === undefined ? '' : `kind=${JSON.stringify(params.kind)}`})`,
  }),
  defineAction({
    type: 'field.categories',
    title: 'Read the categories of a field',
    summary: 'Each category of a categorical field with its cells, the cells shown in the active view, its colour and whether it is shown.',
    group: 'Dataset',
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: { field: FIELD },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['field', 'view', 'categories', 'missing'],
      properties: {
        field: { type: 'string' },
        view: { type: 'string', description: 'The view the colours and shown counts are of (the selected one), named as actions name views ("View N").' },
        categories: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['label', 'cells', 'visible', 'color', 'shown'],
            properties: {
              label: { type: 'string' },
              cells: COUNT,
              visible: { ...COUNT, description: 'Cells of it the view shows (every filter applied).' },
              color: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
              shown: { type: 'boolean', description: 'False when the category is hidden in the view.' },
            },
          },
        },
        missing: { ...COUNT, description: 'Open cells without a category.' },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Read the categories of ${quote.bare(params.field.key)}`,
    code: params => `categories(${JSON.stringify(params.field.key)})`,
  }),
  defineAction({
    type: 'genes.search',
    title: 'Search the genes',
    summary: 'Gene names matching what is typed, best first, as the gene search box ranks them.',
    group: 'Dataset',
    params: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, examples: ['CD3'] },
        limit: { type: 'integer', minimum: 1, default: 20, description: 'At most this many names.' },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['genes', 'matches', 'total'],
      properties: {
        genes: { type: 'array', items: { type: 'string' } },
        matches: { ...COUNT, description: 'How many genes match in all.' },
        total: { ...COUNT, description: 'How many genes the dataset has.' },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Searched the genes for ${quote(params.query)}`,
    code: params => `search_genes(${JSON.stringify(params.query)})`,
  }),
  defineAction({
    type: 'cells.values',
    title: 'Read values of cells',
    summary: 'The values of named cells (original positions) in each field or gene asked for.',
    group: 'Dataset',
    params: {
      type: 'object', additionalProperties: false, required: ['cells', 'fields'],
      properties: {
        cells: {
          type: 'array', items: { type: 'integer', minimum: 0 }, 'x-cells': true, minItems: 1,
          description: 'Cells by original position (their row in the file\'s obs).',
        },
        fields: { type: 'array', items: FIELD, minItems: 1 },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['cells', 'columns', 'not_open'],
      properties: {
        cells: { type: 'array', items: COUNT, description: 'The cells asked for that are open, in the order asked.' },
        columns: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['field', 'values'],
            properties: {
              field: FIELD_RESULT,
              values: { type: 'array', items: { type: ['string', 'number', 'null'] }, description: 'One per cell; null where it has none (or a gene was not read for it).' },
            },
          },
        },
        not_open: { type: 'array', items: COUNT, description: 'Cells asked for that are not open (a subsample).' },
      },
    },
    describe: params => `Read ${formatCountOf(params.fields.length, 'field')} of ${formatCountOf(params.cells.length, 'cell')}`,
    code: params => `cell_values(cells=[…${params.cells.length}], fields=${JSON.stringify(params.fields.map(field => field.key))})`,
  }),
  defineAction({
    type: 'field.summary',
    title: 'Summarise a field per category',
    summary: 'A continuous field or a gene per category of a categorical field (cells, mean, median, range, share above zero), or a categorical field\'s top categories per category.',
    group: 'Dataset',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'by'],
      properties: {
        field: FIELD,
        by: { ...FIELD, description: 'The categorical obs field to group the cells by.' },
        top: TOP('For a categorical field: at most this many of its categories per group.'),
        visible_only: { type: 'boolean', default: false, description: 'Only the cells the active view shows.' },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['field', 'by', 'read_for', 'groups'],
      properties: {
        field: FIELD_RESULT,
        by: { type: 'string' },
        read_for: {
          type: ['object', 'null'], additionalProperties: false, required: ['cells', 'of'],
          description: 'For a gene read for a sample of the open cells: the cells its statistics are of.',
          properties: { cells: COUNT, of: COUNT },
        },
        groups: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['label', 'cells'],
            properties: {
              label: { type: 'string' },
              cells: COUNT,
              mean: { type: ['number', 'null'] },
              median: { type: ['number', 'null'] },
              min: { type: ['number', 'null'] },
              max: { type: ['number', 'null'] },
              above_zero: { type: ['number', 'null'], description: 'Share of the cells with a value above zero.' },
              top: {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false, required: ['label', 'cells'],
                  properties: { label: { type: 'string' }, cells: COUNT },
                },
              },
            },
          },
        },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Summarised ${quote.bare(params.field.key)} by ${quote.bare(params.by.key)}`,
    code: params => `summarize(${JSON.stringify(params.field.key)}, by=${JSON.stringify(params.by.key)})`,
  }),
  defineAction({
    type: 'views.state',
    title: 'Read the views',
    summary: 'Each open view: its name (what actions name it by), its title, the representation it shows, what it is coloured by, its filters and camera; the layout; the highlight pages with their groups.',
    group: 'Views',
    params: NO_PARAMS,
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['active', 'layout', 'cameras_locked', 'views', 'highlights'],
      properties: {
        active: { type: 'string', description: 'The name of the view the controls act on ("View N").' },
        layout: { type: 'string', enum: ['single', 'grid'] },
        cameras_locked: { type: 'boolean' },
        views: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['name', 'title', 'live', 'active', 'representation', 'colored_by', 'filters', 'camera'],
            properties: {
              name: { type: 'string', description: 'What actions name the view by: "View N" as the Compare views list numbers it.' },
              title: { type: 'string', description: 'What its title chip shows (what it is coloured by).' },
              live: { type: 'boolean', description: 'The live view (the others are kept views).' },
              active: { type: 'boolean' },
              representation: {
                type: ['object', 'null'], additionalProperties: false, required: ['name', 'dimension'],
                properties: { name: { type: 'string' }, dimension: { type: 'integer', minimum: 1 } },
              },
              colored_by: { oneOf: [FIELD_RESULT, { type: 'null' }] },
              filters: { type: 'array', items: { type: 'string' } },
              camera: { oneOf: [CAMERA, { type: 'null' }] },
            },
          },
        },
        highlights: {
          type: 'object', additionalProperties: false, required: ['active_page', 'pages'],
          properties: {
            active_page: { type: ['string', 'null'] },
            pages: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false, required: ['name', 'cells', 'groups'],
                properties: {
                  name: { type: 'string' },
                  cells: COUNT,
                  groups: {
                    type: 'array',
                    items: {
                      type: 'object', additionalProperties: false, required: ['name', 'cells', 'enabled'],
                      properties: { name: { type: 'string' }, cells: COUNT, enabled: { type: 'boolean' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    describe: () => 'Read the views',
    code: () => 'views()',
  }),
  defineAction({
    type: 'view.picture',
    title: 'Take a picture of a view',
    summary: 'A PNG of a view as the figure export draws it (points, legend), returned as base64; nothing is downloaded.',
    group: 'Views',
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        view: { ...VIEW, description: 'The view: "View N" as the Compare views list numbers it; the selected view when left out.' },
        width: { type: 'integer', minimum: 100, maximum: 20000, default: 640, description: 'The plot\'s width in pixels (the picture adds its margins and the legend).' },
        height: { type: 'integer', minimum: 100, maximum: 20000, default: 480, description: 'The plot\'s height in pixels.' },
        legend: { type: 'boolean', default: true, description: 'Draw the colour legend beside the plot.' },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['png', 'width', 'height', 'plot', 'view', 'notes'],
      properties: {
        png: {
          type: 'string', contentEncoding: 'base64', contentMediaType: 'image/png',
          description: 'The image, base64-encoded PNG bytes (an agent receives it as an image).',
        },
        width: { type: 'integer', description: 'The image\'s width in pixels.' },
        height: { type: 'integer', description: 'The image\'s height in pixels.' },
        plot: {
          type: 'object', additionalProperties: false, required: ['width', 'height'],
          description: 'The plot\'s size in the image, as asked for.',
          properties: { width: { type: 'integer' }, height: { type: 'integer' } },
        },
        view: { type: 'string', description: 'The view drawn, by its name.' },
        notes: { type: 'array', items: { type: 'string' }, description: 'What the picture leaves out of what the view shows (an overlay it cannot draw).' },
      },
    },
    describe: () => 'Took a picture of a view',
    code: params => `picture(${params.view === undefined ? '' : JSON.stringify(params.view)})`,
  }),
]);
