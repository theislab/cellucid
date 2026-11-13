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

import { PLACES, placePath } from '../../ui/place-names.js';
import { defineAction } from '../catalog.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { CATEGORY_FIELD, CATEGORY_LABEL, FIELD, VIEW } from './params.js';



const EXPRESSION_PLACE = placePath(PLACES.dataMapping, PLACES.expressionValues);
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
    summary: 'The open dataset: its name, description, citation, how many cells (and how many are open), genes, embeddings, vector fields and fields.',
    group: 'Dataset',
    params: NO_PARAMS,
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false,
      required: ['name', 'id', 'source', 'description', 'citation', 'cells', 'genes', 'embeddings', 'vector_fields', 'fields'],
      properties: {
        name: { type: ['string', 'null'] },
        id: { type: ['string', 'null'], description: 'The dataset\'s id where it has one.' },
        source: { type: ['string', 'null'], description: 'Where it was opened from (a sample, a link, a local file, a notebook).' },
        description: { type: ['string', 'null'], description: 'What the dataset says of itself (its card\'s paragraph), as its authors wrote it.' },
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
          type: 'object', additionalProperties: false, required: ['count', 'read_for', 'values', 'modality', 'modalities'],
          properties: {
            count: COUNT,
            modality: { type: ['string', 'null'], description: 'The modality the genes (features) are read from, in a dataset of several (MuData); null with one.' },
            modalities: {
              type: ['array', 'null'],
              description: `Every modality of a dataset of several, as ${placePath(PLACES.dataMapping)} › Modality lists them (null with one); mapping_set {modality} reads another's features as the genes.`,
              items: {
                type: 'object', additionalProperties: false, required: ['name', 'about', 'usable', 'reason'],
                properties: {
                  name: { type: 'string' },
                  about: { type: 'string', description: 'Its features and the cells measured, as the select says ("prot · 5 features · 36 of 44 cells").' },
                  usable: { type: 'boolean' },
                  reason: { type: ['string', 'null'], description: 'Why it cannot be read, when not usable.' },
                },
              },
            },
            read_for: {
              type: ['object', 'null'], additionalProperties: false, required: ['cells', 'of'],
              description: 'The open cells a gene is read for, when not every open cell (Genes read for).',
              properties: { cells: COUNT, of: COUNT },
            },
            values: {
              type: ['object', 'null'], additionalProperties: false,
              required: ['normalize', 'log1p', 'shown', 'offered', 'reason', 'totals'],
              description: `The expression transform (${EXPRESSION_PLACE}, expression_transform_set): what is asked, what the genes are shown and analyzed in, and where each cell's total comes from. Null without genes.`,
              properties: {
                normalize: { type: 'boolean', description: 'Asked: each cell scaled to 10,000 counts.' },
                log1p: { type: 'boolean', description: 'Asked: ln(1 + x), after the normalization.' },
                shown: { type: 'string', description: 'What every gene view, filter, read and analysis uses now: Raw values, Normalized, log1p or Normalized · log1p (pseudobulk differential expression always sums raw counts).' },
                offered: { type: 'boolean', description: 'Whether the mapped matrix takes the transform (it holds counts, not log1p values).' },
                reason: { type: ['string', 'null'], description: 'Why it is not offered.' },
                totals: {
                  type: 'object', additionalProperties: false, required: ['stored', 'field', 'over', 'genes_summed'],
                  description: 'Where the cells\' totals come from: an obs column (free) or every gene summed (one pass over the matrix, heavy work).',
                  properties: {
                    stored: { type: 'boolean' },
                    field: { type: ['string', 'null'], description: 'The obs column.' },
                    over: { type: ['string', 'null'], description: 'What the column covers, as the file says: all genes, source panel or stored genes (null: not said).' },
                    genes_summed: { ...COUNT, description: 'Genes a sum over the matrix reads (0 from a column).' },
                  },
                },
              },
            },
          },
        },
        embeddings: {
          type: 'array',
          description: `Every embedding the data mapping offers (${placePath(PLACES.dataMapping)}), on or off: view_embedding_set shows one that is on by its key and columns; mapping_set turns one on (any columns of an array wider than 3, one column for a 1D embedding).`,
          items: {
            type: 'object', additionalProperties: false, required: ['name', 'dimension', 'key', 'columns', 'width', 'enabled', 'usable', 'reason'],
            properties: {
              name: { type: 'string', description: 'As the embedding picker names it.' },
              dimension: { type: ['integer', 'null'], minimum: 1, description: 'Null for an array that cannot be plotted.' },
              key: { type: 'string', description: 'The obsm array.' },
              columns: { type: ['array', 'null'], items: { type: 'integer', minimum: 0 }, description: 'The columns plotted (for one off: the ones it would plot first).' },
              width: { type: ['integer', 'null'], minimum: 1, description: 'The array\'s columns.' },
              enabled: { type: 'boolean', description: 'On: shown in the pickers and views.' },
              usable: { type: 'boolean' },
              reason: { type: ['string', 'null'], description: 'Why it cannot be plotted, when not usable.' },
            },
          },
        },
        vector_fields: {
          type: 'array', items: { type: 'string' },
          description: 'Per-cell vectors (RNA velocity, drift) the vector field overlay draws on the embeddings they belong to, by name; settings.list has its settings.',
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
    summary: 'Each category of a categorical field with its cells, the cells shown in the active view, its color and whether it is shown.',
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
        view: { type: 'string', description: 'The view the colors and shown counts are of (the selected one), named as actions name views ("View N").' },
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
    summary: 'Gene names matching what is typed, best first, as the gene search box ranks them; or, given names, which of them the dataset has.',
    group: 'Dataset',
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, examples: ['CD3'], description: 'What is typed (give it or names).' },
        names: {
          type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, examples: [['SOX9', 'SFTPC']],
          description: 'Gene names to look up at once, exact in any case: genes lists those the dataset has, as it names them; lacks the rest.',
        },
        limit: { type: 'integer', minimum: 1, default: 20, description: 'At most this many names (for a query).' },
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
        lacks: { type: 'array', items: { type: 'string' }, description: 'Of the names asked for, those that are not genes of the dataset.' },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.names === undefined
      ? `Searched the genes for ${quote(params.query)}`
      : `Looked up ${formatCountOf(params.names.length, 'gene name')}`),
    code: params => (params.names === undefined
      ? `search_genes(${JSON.stringify(params.query)})`
      : `search_genes(names=${JSON.stringify(params.names)})`),
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
      type: 'object', additionalProperties: false, required: ['cells', 'columns', 'not_open', 'gene_values'],
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
        gene_values: { type: ['string', 'null'], description: `The genes' values as shown and analyzed (${EXPRESSION_PLACE}): raw counts as stored, or the transform and where the cells' totals came from; null when no gene was read.` },
      },
    },
    describe: params => `Read ${formatCountOf(params.fields.length, 'field')} of ${formatCountOf(params.cells.length, 'cell')}`,
    code: params => `cell_values(cells=[…${params.cells.length}], fields=${JSON.stringify(params.fields.map(field => field.key))})`,
  }),
  defineAction({
    type: 'field.summary',
    title: 'Summarize a field per category',
    summary: 'A continuous field or a gene per category of a categorical field (cells, mean, median, range, share above zero), or a categorical field\'s top categories per category.',
    group: 'Dataset',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'by'],
      properties: {
        field: FIELD,
        by: { ...FIELD, description: 'The categorical obs field to group the cells by.' },
        categories: {
          type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, uniqueItems: true,
          description: 'Only these categories of `by`, by name (else every category with cells).',
        },
        top: TOP('For a categorical field: at most this many of its categories per group.'),
        visible_only: { type: 'boolean', default: false, description: 'Only the cells the active view shows.' },
        // `within` leaves the view as it is: without it an agent summarizes a subset by hiding the person's
        // cells with filter steps and then putting the view back.
        within: {
          type: 'object', additionalProperties: false, required: ['field'],
          description: 'Only the cells of some categories of another categorical field, or in a range of a continuous field or gene (both ends included), leaving the view as it is: donors within one cell type, cell types per age range.',
          properties: {
            field: FIELD,
            categories: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, uniqueItems: true, description: 'For a categorical field: its categories, by name.' },
            min: { type: 'number', description: 'For a continuous field or a gene: the least value kept.' },
            max: { type: 'number', description: 'For a continuous field or a gene: the largest value kept.' },
          },
        },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['field', 'by', 'within', 'read_for', 'values', 'groups', 'empty'],
      properties: {
        field: FIELD_RESULT,
        by: { type: 'string' },
        within: {
          type: ['object', 'null'], additionalProperties: false, required: ['field', 'cells'],
          description: 'The cells kept by `within`: its field and how many open cells it keeps; null without it.',
          properties: { field: { type: 'string' }, cells: COUNT },
        },
        values: { type: ['string', 'null'], description: `For a gene: its values as shown and analyzed (${EXPRESSION_PLACE}, expression_transform_set): raw counts as stored, or the transform and where the cells' totals came from; null for an obs field.` },
        empty: { ...COUNT, description: 'Categories of `by` left out for having no cells (none open, or none the view shows).' },
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
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Summarized ${quote.bare(params.field.key)} by ${quote.bare(params.by.key)}`,
    code: params => `summarize(${JSON.stringify(params.field.key)}, by=${JSON.stringify(params.by.key)}${params.categories === undefined ? '' : `, categories=${JSON.stringify(params.categories)}`}${params.within === undefined ? '' : `, within=${JSON.stringify(params.within)}`})`,
  }),
  defineAction({
    type: 'vector-field.summary',
    title: 'Summarize where cells are heading',
    summary: 'Where the cells of each category of a field are heading along a vector field (RNA velocity, a drift), in the embedding a view shows: per category, how fast (mean speed relative to the mean cell), how aligned its arrows are, their mean direction in the view\'s axes, and the categories its arrows lead into (each cell\'s arrow shared among its nearest cells by how directly it points at them, as scVelo\'s velocity graph does, here in the embedding). Read from the arrows as drawn in that embedding, not from the genes: an embedding can bend, merge or reverse a flow.',
    group: 'Dataset',
    params: {
      type: 'object', additionalProperties: false, required: ['by'],
      properties: {
        by: { ...CATEGORY_FIELD, description: 'The categorical field to group the cells by.' },
        vector_field: { type: 'string', minLength: 1, examples: ['velocity'], description: 'The vector field, by name (dataset_summary lists them). Left out: the one the overlay shows, else the dataset\'s default, else the only one bound to the view\'s embedding; with several bound and none of those, name one.' },
        view: { ...VIEW, description: 'The view whose embedding the arrows are read in: "View N"; the selected view when left out.' },
        categories: { type: 'array', items: CATEGORY_LABEL, minItems: 1, uniqueItems: true, description: 'Only these categories of `by` (else every category with cells); their arrows still lead into every category.' },
        neighbors: { type: 'integer', minimum: 2, default: 30, description: 'How many nearest cells (in the embedding) each cell\'s arrow is shared among.' },
        visible_only: { type: 'boolean', default: false, description: 'Only the cells the view shows (its filters and hidden categories), as cells and as neighbors.' },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false,
      required: ['vector_field', 'view', 'embedding', 'by', 'cells', 'without_vector', 'neighbors', 'groups', 'empty'],
      properties: {
        vector_field: { type: 'string' },
        view: { type: 'string' },
        embedding: {
          type: 'object', additionalProperties: false, required: ['name', 'dimension'],
          properties: { name: { type: 'string' }, dimension: { type: 'integer' } },
        },
        by: { type: 'string' },
        cells: { ...COUNT, description: 'Cells read (with a vector and a category).' },
        without_vector: { ...COUNT, description: 'Cells left out for having no vector.' },
        neighbors: COUNT,
        empty: { ...COUNT, description: 'Categories left out for having no cells read.' },
        groups: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['label', 'cells', 'speed', 'coherence', 'direction', 'heading', 'towards'],
            properties: {
              label: { type: 'string' },
              cells: COUNT,
              speed: { type: 'number', description: 'Mean speed of its cells over the mean of all cells read (1: as fast as the average cell).' },
              coherence: { type: 'number', description: 'How aligned its arrows are, 0 to 1: the length of the mean of their unit vectors (1: all point the same way; near 0: every way, or still).' },
              direction: { type: 'array', items: { type: 'number' }, description: 'The mean direction as a unit vector in the embedding\'s axes (x, y[, z]).' },
              heading: { type: ['string', 'null'], description: 'The direction in words on a 2-D view as drawn (right, up and right, …); null when not 2-D or not aligned (coherence below 0.2).' },
              towards: {
                type: 'array',
                description: 'Where its arrows lead, largest first: each category\'s share of the flow (own category included), shares of 2% or more.',
                items: {
                  type: 'object', additionalProperties: false, required: ['category', 'share'],
                  properties: { category: { type: 'string' }, share: { type: 'number' } },
                },
              },
            },
          },
        },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Summarized where the cells of ${quote.bare(params.by.key)} are heading`,
    code: params => `vector_field_summary(by=${JSON.stringify(params.by.key)}${params.vector_field === undefined ? '' : `, vector_field=${JSON.stringify(params.vector_field)}`})`,
  }),
  defineAction({
    type: 'views.state',
    title: 'Read the views',
    summary: 'Each open view: its name (what actions name it by), the name it was given (view_rename), its title, the representation it shows, what it is colored by, its filters and camera; the layout; the highlight pages with their groups; whether the person\'s system asks for reduced motion.',
    group: 'Views',
    params: NO_PARAMS,
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['active', 'layout', 'cameras_locked', 'views', 'highlights', 'reduced_motion'],
      properties: {
        active: { type: 'string', description: 'The name of the view the controls act on ("View N").' },
        reduced_motion: { type: 'boolean', description: 'The person\'s system asks for reduced motion (an accessibility setting): a camera path goes to its last keyframe at once instead of playing, the camera stops when let go instead of gliding, a zoom arrives at once, the velocity flow is drawn as a still picture and highlights do not pulse. Say so when the person expects motion.' },
        layout: { type: 'string', enum: ['single', 'grid'] },
        cameras_locked: { type: 'boolean' },
        views: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['name', 'label', 'title', 'live', 'active', 'representation', 'colored_by', 'filters', 'camera'],
            properties: {
              name: { type: 'string', description: 'What actions name the view by: "View N" as the Compare views list numbers it.' },
              label: { type: ['string', 'null'], description: 'The name the view was given (view_rename), shown beside its number in its row, on its pane and as its panel\'s title in a figure; null when it has none.' },
              title: { type: 'string', description: 'What its title chip shows (what it is colored by).' },
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
    summary: 'A PNG of a view as the figure export draws it (points, legend), or as the screen shows it now (source "screen": the vector field overlay, the connectivity edges and a playing camera path\'s caption included, which a figure cannot draw), or the whole figure exactly as Export would download it now with the Figure export settings (source "export": size, frame, background, fonts, title, panel titles, legends, every view while Export all views is on: check a figure with it before the person downloads it); returned as base64; nothing is downloaded.',
    group: 'Views',
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        view: { ...VIEW, description: 'The view: "View N" as the Compare views list numbers it; the selected view when left out. Not with source "export" (it draws what Export would).' },
        source: {
          enum: ['figure', 'screen', 'export'], default: 'figure',
          description: 'figure: one view drawn as the figure export draws it (points, legend; no overlay), with plain settings (no title, 12 px text, the screen\'s background). screen: the view\'s pane as the screen shows it now, overlays included (the moving flow caught at this instant), no legend; the view must be on screen. export: the figure Export would download now, with every Figure export setting (figure_export_set), scaled down into width × height (ask 1200 × 1200 or more to read a multi-panel figure\'s titles).',
        },
        width: { type: 'integer', minimum: 100, maximum: 20000, default: 640, description: 'The width of the box the plot fits in, in pixels: the plot keeps the view\'s shape inside width × height, as the figure export frames it (the picture adds its margins and the legend). With source "export": the box the whole figure is scaled down into (never up).' },
        height: { type: 'integer', minimum: 100, maximum: 20000, default: 480, description: 'The height of the box the plot fits in, in pixels (source "export": of the box the figure is scaled into).' },
        legend: { type: 'boolean', default: true, description: 'Draw the color legend beside the plot (a figure picture; the screen has none).' },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['png', 'width', 'height', 'plot', 'view', 'label', 'notes'],
      properties: {
        png: {
          type: 'string', contentEncoding: 'base64', contentMediaType: 'image/png',
          description: 'The image, base64-encoded PNG bytes (an agent receives it as an image).',
        },
        width: { type: 'integer', description: 'The image\'s width in pixels.' },
        height: { type: 'integer', description: 'The image\'s height in pixels.' },
        plot: {
          type: ['object', 'null'], additionalProperties: false, required: ['width', 'height'],
          description: 'The plot\'s size in the image: the largest rectangle of the view\'s shape inside the width × height asked for; null for an "export" picture of every view.',
          properties: { width: { type: 'number' }, height: { type: 'number' } },
        },
        view: { type: ['string', 'null'], description: 'The view drawn, by its name; null for an "export" picture of every view.' },
        label: { type: ['string', 'null'], description: 'The name the view was given (view_rename), or null.' },
        notes: { type: 'array', items: { type: 'string' }, description: 'What the picture leaves out of what the view shows, or draws over it (a figure: an overlay it cannot draw; the screen: the legend; both: the highlighted cells drawn in the highlight\'s color over the coloring); for "export", first the figure\'s own size.' },
      },
    },
    describe: () => 'Took a picture of a view',
    code: params => `picture(${params.view === undefined ? '' : JSON.stringify(params.view)})`,
  }),
]);
