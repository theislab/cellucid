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
import { describeValue } from '../../analysis/options/option-schema.js';
import { PLACES, placePath } from '../../ui/place-names.js';
import { VISIBLE_CELLS_READS, categoriesWords } from './params.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { lowerFirst } from '../../../utils/text-case.js';

const PANEL = PLACES.analysis.name;
const EXPRESSION_PLACE = placePath(PLACES.dataMapping, PLACES.expressionValues);

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
 * open cells and the cells genes are read for, the data mapping and the
 * expression values (Data mapping › Expression values), the fields
 * (user fields, renames), the highlight pages, and for "Visible cells" what
 * the view in focus shows. Quick and Detailed compute as their pages and
 * fields change, and a copied window computes its first result, so the
 * actions that set those off read these too.
 */
const RESULT_INPUTS = Object.freeze([...VISIBLE_CELLS_READS, 'highlights']);
/**
 * What an analysis made on first use takes its opening settings from: the
 * field the view is colored by (its group-by), the fields, genes and pages
 * it offers.
 */
const OPENING_INPUTS = Object.freeze(['active-field', 'field-overlays', 'mapping', 'highlights']);

const where = (params, quote = PLAIN_QUOTE) => (params.in === 'panel' || params.in === undefined ? '' : ` in window ${quote.bare(params.in)}`);
const whereCode = params => (params.in === 'panel' || params.in === undefined ? '' : `, in_=${params.in}`);
const titleOf = name => ANALYSIS_MODES.find(mode => mode.name === name)?.title ?? name;

/** The action parameter schema of one option (`option-schema.js` entry). */
export function optionParamSchema(entry) {
  const description = entry.means === undefined ? entry.label : `${entry.label}: ${entry.means}`;
  switch (entry.kind) {
    case 'select':
    case 'segmented':
      if (entry.pages === true) return { type: 'string', description: `${description}: a highlight page by its name, or "Rest of <page>"` };
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
  required: ['dataset', 'cells', 'genes_read_for', 'mapping', 'values', 'pages', 'visible_only'],
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
    values: { type: ['string', 'null'], description: `The expression values its genes were read in (${EXPRESSION_PLACE}, as the matrix it read takes them): raw values, normalized, log1p or normalized · log1p; raw values for one that reads raw counts whatever the setting (pseudobulk, UCell); null when it read no gene values. The result goes stale only when these would change.` },
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
const TEXT = Object.freeze({ type: 'string' });
const COUNT = Object.freeze({ type: 'integer', minimum: 0 });
const NAMED_COUNTS = Object.freeze({
  type: 'array',
  items: { type: 'object', additionalProperties: false, required: ['name', 'cells'], properties: { name: TEXT, cells: COUNT } },
});
/**
 * How a result was computed (`analysis.result`), as its expanded view's
 * statistics say it: what each analysis gives of these (`_resultAbout` of its
 * UI). Null for an analysis that has none to say (correlation: its rows say
 * it).
 */
const RESULT_ABOUT = Object.freeze({
  type: ['object', 'null'], additionalProperties: false,
  description: 'How it was computed, as its expanded view\'s statistics say: the groups and their cells (samples), the test and its pairing (pseudobulk: its limma model), the correction, the expression matrix and its values, the fold change, tests between pages or groups, what the rows are.',
  properties: {
    group_a: TEXT, cells_a: COUNT, group_b: TEXT, cells_b: COUNT,
    samples_a: COUNT, samples_b: COUNT, samples_left_out: TEXT,
    group_by: TEXT, cells_per_group: NAMED_COUNTS, compared_with: TEXT, groups_tested: TEXT,
    cell_types: TEXT, samples: { type: ['string', 'null'] }, condition: { type: ['string', 'null'] }, cells: COUNT,
    cells_per_unit: NAMED_COUNTS,
    samples_per_condition: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'samples'], properties: { name: TEXT, samples: COUNT } },
    }, overall: TEXT, proportions: TEXT,
    test: { type: ['string', 'null'] }, method: TEXT, multiple_testing: TEXT, expression_matrix: TEXT, fold_change: TEXT,
    values: { ...TEXT, description: `The values computed from (${EXPRESSION_PLACE}, expression_transform_set): ln(1 + x · 10,000 / cell total), x · 10,000 / cell total or ln(1 + x), with where the cell totals came from, or raw counts as stored; pseudobulk: the raw counts summed per sample, TMM factors (and where the library sizes came from) and log-CPM, or each sample's mean of a matrix that is not counts.` },
    model: { ...TEXT, description: 'Pseudobulk: the limma fit, its design (~ group, or ~ donor + group paired) and its empirical-Bayes prior (prior df d0, prior variance s0², trend with the mean).' },
    pairing: { ...TEXT, description: 'Paired or unpaired, and how many samples (donors) have cells in both groups or conditions.' },
    genes_tested: COUNT, significant_up_in_a: COUNT, significant_up_in_b: COUNT, significance: TEXT,
    sets: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'genes', 'not_found', 'constant', 'tests'],
        properties: {
          name: TEXT, genes: COUNT,
          not_found: { type: 'array', items: TEXT }, constant: { type: 'array', items: TEXT },
          tests: {
            description: 'The tests between its pages, or why there are none (one page, pages sharing cells).',
            oneOf: [
              TEXT,
              {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false, required: ['test', 'statistic', 'p_value', 'effect_size', 'effect_size_type'],
                  properties: {
                    test: TEXT, statistic: { type: ['number', 'null'] }, p_value: { type: ['number', 'null'] },
                    effect_size: { type: ['number', 'null'] }, effect_size_type: { type: ['string', 'null'] },
                  },
                },
              },
            ],
          },
        },
      },
    },
    rows: { ...TEXT, description: 'What the rows are and their order.' },
  },
});

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
    if (keys[0] === 'groups') {
      // The groups left open, by their titles: "Showed Values, Layout options of Dot plot".
      const groups = ANALYSIS_MODES.find(mode => mode.name === params.analysis)?.options?.groups ?? [];
      const titles = view.groups.map(id => groups.find(group => group.id === id)?.title ?? id);
      return titles.length === 0
        ? `Closed the option groups of ${title}${at}`
        : `Showed ${titles.join(', ')} options of ${title}${at}`;
    }
    if (keys[0] === 'show') return `Showed ${title} as ${SHOW_WORDS[view.show]}${at}`;
    if (keys[0] === 'group') return `Listed ${view.group === null ? 'the first group' : quote.bare(view.group)} in ${title}${at}`;
    if (keys[0] === 'set') return `Showed the gene set ${quote.bare(view.set)} in ${title}${at}`;
    // As the options column labels them (the outcome's, `plotOptionWords`), else by their keys.
    if (keys[0] === 'plot') {
      return Array.isArray(outcome?.plot)
        ? `${title}: ${outcome.plot.join(', ')}${at}`
        : `Set ${view.plot.map(entry => `${quote.bare(entry.option)} to ${quote.bare(entry.value)}`).join(', ')} in the plot of ${title}${at}`;
    }
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

/**
 * An option's value as a step names it: the label its form shows ("Mean,
 * scaled 0–1 per gene", "On"), the sets of genes with their sizes, a field,
 * a page and categories by name.
 */
function optionValueWords(entry, value, quote) {
  if (entry.kind === 'gene-sets') {
    if (value.length === 0) return 'none';
    // A set by name and size, a few; more (the markers of every group sent on) by their count.
    if (value.length > 3) return `${formatCountOf(value.length, 'gene set')} (${formatCountOf(value.reduce((sum, set) => sum + set.genes.length, 0), 'gene')})`;
    return value.map(set => `${quote.bare(set.name)} (${formatCountOf(set.genes.length, 'gene')})`).join(', ');
  }
  if (entry.kind === 'groups') return value.mode === 'all' ? 'all' : categoriesWords(value.ids, quote);
  if (entry.kind === 'variable') return value === null ? 'none' : quote.bare(value.key);
  if ((entry.kind === 'select' || entry.kind === 'segmented') && typeof entry.choices === 'function') {
    // Choices the data offers: those it offers without data (All cells) by their label, a page and a field by name.
    let fixed = [];
    try { fixed = entry.choices({}, {}) ?? []; } catch { fixed = []; }
    const label = fixed.find(choice => choice.value === value)?.label;
    if (label !== undefined) return label;
    if (typeof value === 'string' && value.startsWith('page:')) return `page ${quote.bare(value.slice('page:'.length))}`;
    return quote.bare(String(value));
  }
  return describeValue(entry, value);
}

/** An option's label inside a sentence: "group by", "min |log2FC|", "X axis". */
function labelInSentence(label) {
  return /^[A-Z][a-z]/.test(label) ? lowerFirst(label) : label;
}

/** The most options a step names one by one; the rest are counted. */
const NAMED_OPTIONS = 5;

/**
 * What was chosen, as the form names the options: "Color set to Mean, scaled
 * 0–1 per gene" for one; for several each label with its value, the first
 * five, apart by semicolons (a value may hold a comma: "Group by cell_type;
 * compare against Rest; top genes per group 5"); null for none. The one naming of an analysis's option steps (set, and
 * opened with options).
 */
function optionsWords(schema, options, quote = PLAIN_QUOTE) {
  const keys = Object.keys(options);
  if (keys.length === 0) return null;
  if (keys.length === 1) {
    const entry = schema.entry(keys[0]);
    return `${entry.label} set to ${optionValueWords(entry, options[keys[0]], quote)}`;
  }
  const phrases = keys.slice(0, NAMED_OPTIONS).map((key, index) => {
    const entry = schema.entry(key);
    const label = index === 0 ? entry.label : labelInSentence(entry.label);
    return `${label} ${optionValueWords(entry, options[key], quote)}`;
  });
  const more = keys.length - NAMED_OPTIONS;
  return more > 0 ? `${phrases.join('; ')}; and ${formatCountOf(more, 'more option')}` : phrases.join('; ');
}

/**
 * The version of each analysis's options parameters (`catalog.js` `version`)
 * and its upgraders: options are given partially, so a step of an earlier
 * version holds options the later one still has, and goes up unchanged.
 *
 * - 2: Pair samples across groups (differential) and
 *   conditions (composition); Group by, Groups to score and Cells
 *   (signature).
 */
const SET_VERSIONS = Object.freeze({ differential: 2, signature: 2, composition: 2 });

function setVersioning(name) {
  const version = SET_VERSIONS[name] ?? 1;
  if (version === 1) return {};
  return { version, upgrade: Object.fromEntries(Array.from({ length: version - 1 }, (_, index) => [index + 1, params => params])) };
}

function perAnalysisActions(mode) {
  const optionsSchema = optionsParamSchema(mode.options);
  return [
    defineAction({
      type: `analysis.${mode.name}.set`,
      ...setVersioning(mode.name),
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
      // "Dot plot: Color set to Mean, scaled 0–1 per gene", "Marker genes: Group by cell_type; top genes per
      // group 5": what was chosen, as the form names the options.
      describe: (params, outcome, quote = PLAIN_QUOTE) => {
        // The options the step changed (its outcome's `changed`), else every option given (a step not run yet).
        const changed = typeof outcome?.changed === 'string' ? new Set(outcome.changed.split(', ')) : null;
        const named = changed === null ? params.options : Object.fromEntries(Object.entries(params.options).filter(([key]) => changed.has(key)));
        const words = optionsWords(mode.options, named, quote);
        if (params.show === true) return `Opened ${mode.title}${words === null ? '' : `: ${words}`}${where(params, quote)}`;
        return `${mode.title}: ${words ?? 'options unchanged'}${where(params, quote)}`;
      },
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
    summary: `Run an analysis with its options and pages, and wait for its result. The ${PANEL} panel shows one analysis at a time: run in it, an analysis is shown first when another is (its section and the sidebar must be open).`,
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
    summary: 'Stop a running analysis, at once, also while its run is still waiting for it; what it was showing stays, nothing else changes.',
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false, required: ['analysis'],
      properties: { analysis: RUNNABLE_ANALYSIS, in: WHERE },
    },
    reads: [],
    // Stepless, so it never waits behind the run it stops (catalog.js `isSteplessEffect`).
    effect: 'control',
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
    summary: 'The top rows of an analysis\'s result table (N a parameter), with how it was tested (groups and their cells, test, matrix), what it was computed on and whether it is stale.',
    group: 'Analysis',
    params: {
      type: 'object', additionalProperties: false, required: ['analysis'],
      properties: {
        analysis: RUNNABLE_ANALYSIS,
        in: WHERE,
        top: { type: 'integer', minimum: 1, default: 20, description: 'At most this many rows: per group of marker genes, per direction of a differential expression (top 40: 40 up in A and 40 up in B); about.rows says how it counted.' },
      },
    },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false,
      required: ['analysis', 'columns', 'rows', 'total_rows', 'about', 'stale', 'stale_reasons', 'computed_on'],
      properties: {
        analysis: { type: 'string' },
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
        total_rows: { type: 'integer', description: 'Rows in the whole result.' },
        about: RESULT_ABOUT,
        stale: { type: 'boolean' },
        stale_reasons: { type: 'array', items: { type: 'string' } },
        computed_on: PROVENANCE,
      },
    },
    describe: params => `Read the ${titleOf(params.analysis).toLowerCase()} result`,
    code: params => `analysis_result(${JSON.stringify(params.analysis)}${whereCode(params)}, top=${params.top})`,
  }),
  defineAction({
    type: 'analysis.export',
    title: 'Export an analysis result',
    summary: 'Write an analysis\'s whole result table as a CSV file, as its expanded view\'s CSV button does: differential expression every gene with scanpy\'s columns (scores, logfoldchanges, pvals, pvals_adj, pct_nz_group, pct_nz_reference, auroc, means, cells); marker genes the shown markers of each group, or with all every gene of every group; the dot plot one row per group and gene; gene signature every cell\'s score per set and page (per set and group with a Group by field); composition the results per cell type with a test, else the counts; correlation each page\'s statistics. Refused, saying why, when there is no result or it is out of date (run it again first).',
    group: 'Exports',
    params: {
      type: 'object', additionalProperties: false, required: ['analysis'],
      properties: {
        analysis: RUNNABLE_ANALYSIS,
        in: WHERE,
        all: { type: 'boolean', default: false, description: 'Marker genes only: every gene of every group (the All genes CSV) instead of the shown markers.' },
      },
    },
    reads: [],
    effect: 'outside',
    confirm: 'writes-file',
    acts: { one: 'file written', other: 'files written' },
    result: {
      type: 'object', additionalProperties: false, required: ['analysis', 'file', 'bytes'],
      properties: {
        analysis: { type: 'string', description: 'The analysis exported.' },
        file: { type: 'string', description: 'The file written.' },
        bytes: { type: 'integer', minimum: 0 },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Exported the ${titleOf(params.analysis).toLowerCase()} result${params.all === true ? ' (every gene)' : ''}${where(params, quote)} as CSV`,
    code: params => `export_analysis(${JSON.stringify(params.analysis)}${whereCode(params)}${params.all === true ? ', all=True' : ''})`,
  }),
  ...ANALYSIS_MODES.filter(mode => mode.options !== null).flatMap(perAnalysisActions),
]);
