/**
 * @fileoverview Analyses: open one (in the panel or a window), choose its
 * pages and options, run it, stop it, copy, move and close windows, and read
 * its settings and results with what they were computed on and whether they
 * are stale.
 *
 * Derived from the analyses' own option schemas
 * (`analysis/options/analysis-modes.js`): each analysis with options has
 * `analysis.<name>.set` (its options, typed from its schema) and
 * `analysis.<name>.get`; a new option needs no code here. An analysis is
 * named by its action name (`markers`, `differential`, …); where it is, by
 * `in`: `"panel"` (the Analysis panel, the default) or the window's number
 * (1 for the first floating analysis window open, in the order they opened).
 * Pages are named by their names as shown. The implementations are the
 * analysis module's (`analysis/actions.js`).
 *
 * @module app/actions/definitions/analysis
 */

import { defineAction } from '../catalog.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { ANALYSIS_MODES } from '../../analysis/options/analysis-modes.js';
import {
  HEATMAP_VIEW_CHOICES, HEATMAP_VIEW_SWITCHES, MARKER_SHOW_CHOICES, viewKeysOf,
} from '../../analysis/options/analysis-views.js';
import { PLACES } from '../../ui/place-names.js';
import { VISIBLE_CELLS_READS } from './params.js';

const PANEL = PLACES.analysis.name;

const NAMES = ANALYSIS_MODES.map(mode => mode.name);
const RUNNABLE = ANALYSIS_MODES.filter(mode => mode.options !== null).map(mode => mode.name);

const ANALYSIS = Object.freeze({
  type: 'string', enum: NAMES,
  description: 'The analysis: markers (marker genes), differential (differential expression), dotplot, signature (gene signature), composition, quick, detailed, correlation.',
});
const RUNNABLE_ANALYSIS = Object.freeze({ ...ANALYSIS, enum: RUNNABLE, description: 'An analysis with a Run button.' });
const WHERE = Object.freeze({
  oneOf: [
    { type: 'string', const: 'panel', description: `The ${PANEL} panel.` },
    { type: 'integer', minimum: 1, description: 'A floating analysis window, by its number (1 is the first open).' },
  ],
  default: 'panel',
});
const WINDOW = Object.freeze({ type: 'integer', minimum: 1, description: 'A floating analysis window, by its number (1 is the first open).' });

/**
 * What an analysis result is computed on (`shared/result-provenance.js`): the
 * open cells and the cells genes are read for, the data mapping, the fields
 * (user fields, renames), the highlight pages, and for "Visible cells" what
 * the view in focus shows. Quick and Detailed compute as their pages and
 * fields change, and a copied window computes its first result, so the
 * actions that set those off read these too.
 */
const RESULT_INPUTS = Object.freeze([...VISIBLE_CELLS_READS, 'highlights']);
/**
 * What an analysis made on first use takes its opening settings from: the
 * field the view is coloured by (its group-by), the fields, genes and pages
 * it offers.
 */
const OPENING_INPUTS = Object.freeze(['active-field', 'field-overlays', 'mapping', 'highlights']);

const where = (params, quote = PLAIN_QUOTE) => (params.in === 'panel' || params.in === undefined ? '' : ` in window ${quote.bare(params.in)}`);
const whereCode = params => (params.in === 'panel' || params.in === undefined ? '' : `, in_=${params.in}`);
const titleOf = name => ANALYSIS_MODES.find(mode => mode.name === name)?.title ?? name;

/** The action parameter schema of one option (`option-schema.js` entry). */
export function optionParamSchema(entry) {
  const description = entry.label;
  switch (entry.kind) {
    case 'select':
    case 'segmented':
      return Array.isArray(entry.choices)
        ? { type: 'string', enum: entry.choices.map(choice => choice.value), description }
        : { type: 'string', description };
    case 'flags':
      return {
        type: 'array', uniqueItems: true, description,
        items: Array.isArray(entry.choices) ? { type: 'string', enum: entry.choices.map(choice => choice.value) } : { type: 'string' },
      };
    case 'number': {
      const schema = { type: entry.integer === true ? 'integer' : 'number', description };
      if (entry.min !== undefined) schema.minimum = entry.min;
      if (entry.max !== undefined) schema.maximum = entry.max;
      return schema;
    }
    case 'boolean':
      return { type: 'boolean', description };
    case 'text':
      return { type: 'string', description };
    case 'groups':
      return {
        description: `${description}: all, or the categories (or pages) by name`,
        oneOf: [
          { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { type: 'string', const: 'all' } } },
          {
            type: 'object', additionalProperties: false, required: ['mode', 'ids'],
            properties: {
              mode: { type: 'string', const: 'subset' },
              ids: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
            },
          },
        ],
      };
    case 'gene-sets':
      return {
        type: 'array', description,
        items: {
          type: 'object', additionalProperties: false, required: ['name', 'genes'],
          properties: {
            name: { type: 'string', minLength: 1 },
            genes: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
        },
      };
    case 'variable':
      return {
        description: `${description}: a field (continuous_obs, categorical_obs) or a gene (gene_expression) by key, or null`,
        oneOf: [
          { type: 'null' },
          {
            type: 'object', additionalProperties: false, required: ['type', 'key'],
            properties: { type: { type: 'string', enum: [...(entry.types ?? [])] }, key: { type: 'string', minLength: 1 } },
          },
        ],
      };
    default:
      throw new TypeError(`Option "${entry.key}" has a kind no action parameter is derived for: ${entry.kind}`);
  }
}

/** One analysis's options as action parameters: every option, none required. */
export function optionsParamSchema(options) {
  return {
    type: 'object', additionalProperties: false,
    properties: Object.fromEntries(options.entries.map(entry => [entry.key, optionParamSchema(entry)])),
  };
}

const PROVENANCE = Object.freeze({
  type: ['object', 'null'], additionalProperties: false,
  required: ['dataset', 'cells', 'genes_read_for', 'mapping', 'pages', 'visible_only'],
  description: 'What the result was computed on.',
  properties: {
    dataset: { type: ['string', 'null'] },
    cells: {
      type: ['object', 'null'], additionalProperties: false, required: ['open', 'of', 'share', 'method', 'seed', 'digest'],
      properties: {
        open: { type: 'integer' }, of: { type: 'integer' }, share: { type: 'number' },
        method: { type: ['string', 'null'] }, seed: { type: ['integer', 'null'] }, digest: { type: 'string' },
      },
    },
    genes_read_for: {
      type: ['object', 'null'], additionalProperties: false, required: ['cells', 'of'],
      properties: { cells: { type: 'integer' }, of: { type: 'integer' } },
    },
    mapping: { type: ['string', 'null'] },
    pages: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'cells'],
        properties: { name: { type: 'string' }, cells: { type: ['integer', 'null'] } },
      },
    },
    visible_only: { type: 'boolean' },
  },
});

/** The analyses with a view to set (`analysis/options/analysis-views.js`). */
const VIEWED = ANALYSIS_MODES.filter(mode => viewKeysOf(mode).length > 0);
const VIEWED_ANALYSIS = Object.freeze({ ...ANALYSIS, enum: VIEWED.map(mode => mode.name), description: 'An analysis with an options form.' });
const OPTION_GROUPS = [...new Set(VIEWED.flatMap(mode => mode.options.groups.map(group => group.id)))];

/** How an analysis is shown; every key optional, each analysis takes its own (`viewKeysOf`). */
const VIEW = Object.freeze({
  type: 'object', additionalProperties: false,
  description: 'What to change of how the analysis is shown (only the keys given).',
  properties: {
    more: { type: 'boolean', description: 'Whether its "More options" are open.' },
    groups: {
      type: 'array', uniqueItems: true, items: { type: 'string', enum: OPTION_GROUPS },
      description: 'The option groups open inside "More options", by id (every other is closed).',
    },
    show: { type: 'string', enum: [...MARKER_SHOW_CHOICES], description: 'Marker genes: what the result shows.' },
    group: {
      type: ['string', 'null'], minLength: 1,
      description: 'Marker genes: the group its expanded table lists, by name (null: the first tested group).',
    },
    heatmap: {
      type: 'object', additionalProperties: false,
      description: 'Marker genes: the heatmap\'s look and clustering (only the keys given).',
      properties: {
        ...Object.fromEntries(Object.entries(HEATMAP_VIEW_CHOICES).map(([key, values]) => [key, { type: 'string', enum: [...values] }])),
        ...Object.fromEntries(HEATMAP_VIEW_SWITCHES.map(key => [key, { type: 'boolean' }])),
      },
    },
    set: { type: 'string', minLength: 1, description: 'Gene signature: the gene set a result of one score per set shows, by name.' },
    plot: {
      type: 'array', minItems: 1,
      description: 'Options of the plot its expanded view draws, each by its name and value as the expanded view offers it.',
      items: {
        type: 'object', additionalProperties: false, required: ['option', 'value'],
        properties: {
          option: { type: 'string', minLength: 1 },
          value: { type: ['string', 'number', 'boolean', 'null'] },
        },
      },
    },
  },
  examples: [{ show: 'list' }],
});

const SHOW_WORDS = Object.freeze({ list: 'a list', heatmap: 'a heatmap', clustered: 'a clustered heatmap' });

/** The keys a view names, the heatmap's own included: `heatmap.colorscale,show`. */
function viewKeysWords(view) {
  return Object.keys(view)
    .flatMap(key => (key === 'heatmap' ? Object.keys(view.heatmap).map(part => `heatmap.${part}`)
      : key === 'plot' ? view.plot.map(entry => `plot.${entry.option}`) : [key]))
    .sort()
    .join(',');
}

/** "Showed Marker genes as a list", "Opened More options of Dot plot", … */
function describeView(params, outcome, quote = PLAIN_QUOTE) {
  const title = titleOf(params.analysis);
  const view = params.view;
  const keys = Object.keys(view);
  const at = where(params, quote);
  if (keys.length === 1) {
    if (keys[0] === 'more') return `${view.more ? 'Opened' : 'Closed'} More options of ${title}${at}`;
    if (keys[0] === 'show') return `Showed ${title} as ${SHOW_WORDS[view.show]}${at}`;
    if (keys[0] === 'group') return `Listed ${view.group === null ? 'the first group' : quote.bare(view.group)} in ${title}${at}`;
    if (keys[0] === 'set') return `Showed the gene set ${quote.bare(view.set)} in ${title}${at}`;
    if (keys[0] === 'plot') return `Set ${view.plot.map(entry => `${quote.bare(entry.option)} to ${quote.bare(entry.value)}`).join(', ')} in the plot of ${title}${at}`;
  }
  return `Changed how ${title} is shown${at}`;
}

const RESULT_STATE = Object.freeze({
  has_result: { type: 'boolean' },
  running: { type: 'boolean' },
  stale: { type: 'boolean', description: 'The result no longer matches its inputs (the reasons say what changed).' },
  stale_reasons: { type: 'array', items: { type: 'string' } },
  computed_on: PROVENANCE,
});

function perAnalysisActions(mode) {
  const optionsSchema = optionsParamSchema(mode.options);
  return [
    defineAction({
      type: `analysis.${mode.name}.set`,
      title: `Set ${mode.title.toLowerCase()} options`,
      summary: `Change options of the ${mode.title.toLowerCase()} analysis (only those given); nothing runs.`,
      group: 'Analysis',
      params: {
        type: 'object', additionalProperties: false, required: ['options'],
        properties: {
          in: WHERE,
          options: optionsSchema,
          show: {
            type: 'boolean', default: false,
            description: `Also open it in the ${PANEL} panel (with in "panel"), as another analysis's "send to" does.`,
          },
        },
      },
      touches: ['analysis'],
      // Made on first use. Options compute nothing (a display option redraws the result shown).
      reads: OPENING_INPUTS,
      effect: 'state',
      // Typing into an option: one step while it is the last thing changed.
      coalesce: params => `${String(params.in)}:${params.show === true}:${Object.keys(params.options).sort().join(',')}`,
      describe: (params, outcome, quote = PLAIN_QUOTE) => (params.show === true
        ? `Opened ${mode.title} with ${Object.keys(params.options).join(', ') || 'its options'}${where(params, quote)}`
        : `Set ${Object.keys(params.options).join(', ') || 'no options'} of ${mode.title}${where(params, quote)}`),
      code: params => `analysis_set(${JSON.stringify(mode.name)}, ${JSON.stringify(params.options)}${whereCode(params)}${params.show === true ? ', show=True' : ''})`,
    }),
    defineAction({
      type: `analysis.${mode.name}.get`,
      title: `Read ${mode.title.toLowerCase()} options`,
      summary: `The ${mode.title.toLowerCase()} analysis's options, pages and result state.`,
      group: 'Analysis',
      params: { type: 'object', additionalProperties: false, properties: { in: WHERE } },
      reads: [],
      effect: 'read',
      result: {
        type: 'object', additionalProperties: false,
        required: ['analysis', 'in', 'options', 'pages', 'has_result', 'running', 'stale', 'stale_reasons', 'computed_on'],
        properties: {
          analysis: { type: 'string', const: mode.name },
          in: WHERE,
          options: optionsSchema,
          pages: { type: 'array', items: { type: 'string' } },
          ...RESULT_STATE,
        },
      },
      describe: () => `Read the ${mode.title.toLowerCase()} options`,
      code: params => `analysis_get(${JSON.stringify(mode.name)}${whereCode(params)})`,
    }),
  ];
}

export const analysisActions = Object.freeze([
  defineAction({
    type: 'analysis.open',
    title: 'Open an analysis',
    summary: `Show an analysis in the ${PANEL} panel, or open it in a new floating window with the panel's settings.`,
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false, required: ['analysis'],
      properties: {
        analysis: ANALYSIS,
        window: { type: 'boolean', default: false, description: 'Open it in a new floating window.' },
      },
    },
    touches: ['analysis', 'layout'],
    // Its opening settings, and Quick's and Detailed's first result.
    reads: [...RESULT_INPUTS, 'active-field'],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => (params.window
      ? `Opened ${titleOf(params.analysis)} in window ${quote.bare(outcome?.window ?? 'new')}`
      : `Opened ${titleOf(params.analysis)}`),
    code: params => `open_analysis(${JSON.stringify(params.analysis)}${params.window ? ', window=True' : ''})`,
  }),
  defineAction({
    type: 'analysis.close',
    title: 'Close the open analysis',
    summary: `Close the analysis open in the ${PANEL} panel (its settings and result stay).`,
    group: 'Analysis',
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: ['analysis'],
    reads: [],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Closed ${outcome?.title === undefined ? 'the analysis' : quote.bare(outcome.title)}`,
    code: () => 'close_analysis()',
  }),
  defineAction({
    type: 'analysis.pages.set',
    title: 'Choose the pages of an analysis',
    summary: 'The highlight pages an analysis compares (by name, "Rest of <page>" for the rest of a page\'s cells); nothing runs.',
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false, required: ['analysis', 'pages'],
      properties: {
        analysis: ANALYSIS,
        in: WHERE,
        pages: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
      },
    },
    touches: ['analysis'],
    reads: RESULT_INPUTS,
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Chose ${params.pages.length === 0 ? 'no pages' : params.pages.map(quote.bare).join(', ')} for ${titleOf(params.analysis)}${where(params, quote)}`,
    code: params => `analysis_pages(${JSON.stringify(params.analysis)}, ${JSON.stringify(params.pages)}${whereCode(params)})`,
  }),
  defineAction({
    type: 'analysis.quick.set',
    title: 'Choose the fields of the quick analysis',
    summary: 'The categorical columns whose composition and the continuous columns whose statistics the quick analysis shows (only the kinds given; before a choice it shows the first two of each); it updates by itself.',
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        in: WHERE,
        categorical: {
          type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 },
          description: 'Categorical columns of the cells, by name (their composition).',
        },
        continuous: {
          type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 },
          description: 'Continuous columns of the cells, by name (their statistics).',
        },
      },
      examples: [{ categorical: ['cell_type'] }],
    },
    touches: ['analysis'],
    reads: RESULT_INPUTS,
    effect: 'state',
    coalesce: params => `${String(params.in)}:${['categorical', 'continuous'].filter(key => params[key] !== undefined).join(',')}`,
    describe: (params, outcome, quote = PLAIN_QUOTE) => {
      const parts = [
        params.categorical === undefined ? null : `composition of ${params.categorical.length === 0 ? 'no fields' : params.categorical.map(quote.bare).join(', ')}`,
        params.continuous === undefined ? null : `statistics of ${params.continuous.length === 0 ? 'no fields' : params.continuous.map(quote.bare).join(', ')}`,
      ].filter(Boolean);
      return `Showed ${parts.join(' and ') || 'the same fields'} in Quick${where(params, quote)}`;
    },
    code: params => `analysis_quick(${JSON.stringify(Object.fromEntries(['categorical', 'continuous'].filter(key => params[key] !== undefined).map(key => [key, params[key]])))}${whereCode(params)})`,
  }),
  defineAction({
    type: 'analysis.detailed.set',
    title: 'Choose what the detailed analysis plots',
    summary: 'The variable the detailed analysis plots (a field or a gene, by name, or none), the plot, and options of that plot (only those given); it updates by itself.',
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        in: WHERE,
        variable: {
          description: 'What to plot: a column of the cells (categorical_obs, continuous_obs) or a gene (gene_expression) by name, or null for nothing.',
          oneOf: [
            { type: 'null' },
            {
              type: 'object', additionalProperties: false, required: ['type', 'key'],
              properties: {
                type: { type: 'string', enum: ['categorical_obs', 'continuous_obs', 'gene_expression'] },
                key: { type: 'string', minLength: 1 },
              },
            },
          ],
        },
        plot: { type: 'string', minLength: 1, description: 'The plot, by its id as the Plot select offers it for the variable\'s kind.' },
        plot_options: {
          type: 'array', minItems: 1,
          description: 'Options of the plot, each by its name and value.',
          items: {
            type: 'object', additionalProperties: false, required: ['option', 'value'],
            properties: {
              option: { type: 'string', minLength: 1 },
              value: { type: ['string', 'number', 'boolean', 'null'] },
            },
          },
        },
      },
      examples: [{ variable: { type: 'categorical_obs', key: 'cell_type' } }],
    },
    touches: ['analysis'],
    reads: RESULT_INPUTS,
    effect: 'state',
    coalesce: params => `${String(params.in)}:${['variable', 'plot'].filter(key => params[key] !== undefined).join(',')}:${(params.plot_options ?? []).map(entry => entry.option).sort().join(',')}`,
    describe: (params, outcome, quote = PLAIN_QUOTE) => {
      const parts = [];
      if (params.variable !== undefined) parts.push(params.variable === null ? 'nothing' : quote.bare(params.variable.key));
      if (params.plot !== undefined) parts.push(`as a ${quote.bare(params.plot)}`);
      if (params.plot_options !== undefined) parts.push(`with ${params.plot_options.map(entry => quote.bare(entry.option)).join(', ')}`);
      return `Plotted ${parts.join(' ') || 'the same'} in Detailed${where(params, quote)}`;
    },
    code: params => `analysis_detailed(${JSON.stringify(Object.fromEntries(['variable', 'plot', 'plot_options'].filter(key => params[key] !== undefined).map(key => [key, params[key]])))}${whereCode(params)})`,
  }),
  defineAction({
    type: 'analysis.view.set',
    title: 'Change how an analysis is shown',
    summary: 'Open or close its option groups, and choose what its result shows (marker genes: list or heatmap, the group listed, the heatmap\'s look; gene signature: the set shown; the options of the plot its expanded view draws); nothing runs.',
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false, required: ['analysis', 'view'],
      properties: { analysis: VIEWED_ANALYSIS, in: WHERE, view: VIEW },
    },
    touches: ['analysis'],
    reads: [],
    effect: 'view',
    // A disclosure opened and closed, a heatmap option tried twice: one step while it is the
    // last change, of the same keys (so the step's parameters still say all it changed).
    coalesce: params => `${params.analysis}:${String(params.in)}:${viewKeysWords(params.view)}`,
    describe: describeView,
    code: params => `analysis_view(${JSON.stringify(params.analysis)}, ${JSON.stringify(params.view)}${whereCode(params)})`,
  }),
  defineAction({
    type: 'analysis.run',
    title: 'Run an analysis',
    summary: 'Run an analysis with its options and pages, and wait for its result.',
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false, required: ['analysis'],
      properties: { analysis: RUNNABLE_ANALYSIS, in: WHERE },
    },
    touches: ['analysis'],
    reads: RESULT_INPUTS,
    rerun: true,
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Ran ${titleOf(params.analysis)}${where(params, quote)}`,
    code: params => `run_analysis(${JSON.stringify(params.analysis)}${whereCode(params)})`,
  }),
  defineAction({
    type: 'analysis.cancel',
    title: 'Stop an analysis',
    summary: 'Stop a running analysis; what it was showing stays, nothing else changes.',
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false, required: ['analysis'],
      properties: { analysis: RUNNABLE_ANALYSIS, in: WHERE },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['stopped'],
      properties: { stopped: { type: 'boolean', description: 'False when it was not running.' } },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Stopped ${titleOf(params.analysis)}${where(params, quote)}`,
    code: params => `stop_analysis(${JSON.stringify(params.analysis)}${whereCode(params)})`,
  }),
  defineAction({
    type: 'analysis.window.copy',
    title: 'Copy an analysis window',
    summary: 'Open a new floating window with a window\'s analysis and settings.',
    group: 'Analysis',
    params: { type: 'object', additionalProperties: false, required: ['window'], properties: { window: WINDOW } },
    touches: ['analysis', 'layout'],
    reads: RESULT_INPUTS,
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Copied window ${quote.bare(params.window)}${outcome?.window === undefined ? '' : ` to window ${quote.bare(outcome.window)}`}`,
    code: params => `copy_analysis_window(${params.window})`,
  }),
  defineAction({
    type: 'analysis.window.close',
    title: 'Close an analysis window',
    summary: 'Close a floating analysis window (its settings and result go with it; undo brings it back).',
    group: 'Analysis',
    params: { type: 'object', additionalProperties: false, required: ['window'], properties: { window: WINDOW } },
    touches: ['analysis', 'layout'],
    reads: [],
    effect: 'state',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Closed ${outcome?.title === undefined ? 'analysis' : quote.bare(outcome.title)} window ${quote.bare(params.window)}`,
    code: params => `close_analysis_window(${params.window})`,
  }),
  defineAction({
    type: 'analysis.window.place',
    title: 'Move or resize an analysis window',
    summary: 'Give a floating analysis window a place and size; it is kept inside the window.',
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false, required: ['window', 'left', 'top', 'width', 'height'],
      properties: {
        window: WINDOW,
        left: { type: 'number' },
        top: { type: 'number' },
        width: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    touches: ['layout'],
    // A window by its number among the analysis windows open.
    reads: [],
    context: ['analysis'],
    effect: 'layout',
    coalesce: params => String(params.window),
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Moved analysis window ${quote.bare(params.window)}`,
    code: params => `place_analysis_window(${params.window}, left=${params.left}, top=${params.top}, width=${params.width}, height=${params.height})`,
  }),
  defineAction({
    type: 'analysis.size.set',
    title: 'Size an analysis\'s expanded view',
    summary: 'The size and splits an analysis\'s expanded view opens at, remembered per analysis; a person sets them by resizing it.',
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false, required: ['analysis', 'expanded'],
      properties: {
        analysis: ANALYSIS,
        expanded: {
          type: 'object', additionalProperties: false,
          required: ['width', 'height', 'optionsWidth', 'footerHeight', 'statsWidth'],
          description: 'The expanded view\'s box and its splits, in CSS pixels.',
          properties: {
            width: { type: 'number', exclusiveMinimum: 0 },
            height: { type: 'number', exclusiveMinimum: 0 },
            optionsWidth: { type: 'number', exclusiveMinimum: 0, description: 'The options column.' },
            footerHeight: { type: 'number', exclusiveMinimum: 0, description: 'The statistics row.' },
            statsWidth: { type: 'number', exclusiveMinimum: 0, description: 'The statistics column.' },
          },
        },
      },
      examples: [{ analysis: 'markers', expanded: { width: 900, height: 600, optionsWidth: 260, footerHeight: 180, statsWidth: 320 } }],
    },
    touches: ['layout'],
    reads: [],
    effect: 'layout',
    // A drag of its edges and splits: one step while it is the last change.
    coalesce: params => params.analysis,
    describe: params => `Resized the expanded view of ${titleOf(params.analysis)}`,
    code: params => `size_analysis_view(${JSON.stringify(params.analysis)}, width=${params.expanded.width}, height=${params.expanded.height})`,
  }),
  defineAction({
    type: 'analysis.window.collapse',
    title: 'Collapse or expand an analysis window',
    summary: 'Fold a floating analysis window to its title bar, or unfold it again; its analysis is kept.',
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false, required: ['window', 'collapsed'],
      properties: {
        window: WINDOW,
        collapsed: { type: 'boolean', description: 'True folds it to its title bar, false unfolds it.' },
      },
    },
    touches: ['layout'],
    // A window by its number among the analysis windows open.
    reads: [],
    context: ['analysis'],
    effect: 'layout',
    describe: (params, outcome, quote = PLAIN_QUOTE) => `${params.collapsed ? 'Collapsed' : 'Expanded'} analysis window ${quote.bare(params.window)}`,
    code: params => `collapse_analysis_window(${params.window}, ${params.collapsed ? 'True' : 'False'})`,
  }),
  defineAction({
    type: 'analysis.list',
    title: 'List the analyses',
    summary: 'Each analysis of the panel and each analysis window: which is open, its pages, whether it has a result, is running, or is stale and why.',
    group: 'Analysis',
    params: { type: 'object', additionalProperties: false, properties: {} },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['open', 'analyses'],
      properties: {
        open: { type: ['string', 'null'], description: 'The analysis open in the panel.' },
        analyses: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['analysis', 'title', 'in', 'pages', 'has_result', 'running', 'stale', 'stale_reasons', 'computed_on'],
            properties: {
              analysis: { type: 'string', enum: NAMES },
              title: { type: 'string' },
              in: WHERE,
              pages: { type: 'array', items: { type: 'string' } },
              ...RESULT_STATE,
            },
          },
        },
      },
    },
    describe: () => 'Listed the analyses',
    code: () => 'list_analyses()',
  }),
  defineAction({
    type: 'analysis.result',
    title: 'Read an analysis result',
    summary: 'The top rows of an analysis\'s result table (N a parameter), with what it was computed on and whether it is stale.',
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false, required: ['analysis'],
      properties: {
        analysis: RUNNABLE_ANALYSIS,
        in: WHERE,
        top: { type: 'integer', minimum: 1, default: 20, description: 'At most this many rows (per group, where the result has groups).' },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false,
      required: ['analysis', 'columns', 'rows', 'total_rows', 'stale', 'stale_reasons', 'computed_on'],
      properties: {
        analysis: { type: 'string' },
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
        total_rows: { type: 'integer', description: 'Rows in the whole result.' },
        stale: { type: 'boolean' },
        stale_reasons: { type: 'array', items: { type: 'string' } },
        computed_on: PROVENANCE,
      },
    },
    describe: params => `Read the ${titleOf(params.analysis).toLowerCase()} result`,
    code: params => `analysis_result(${JSON.stringify(params.analysis)}${whereCode(params)}, top=${params.top})`,
  }),
  ...ANALYSIS_MODES.filter(mode => mode.options !== null).flatMap(perAnalysisActions),
]);
