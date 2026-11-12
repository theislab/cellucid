/**
 * @fileoverview Files the person receives, made from what the page shows:
 * the figure (`figure.export`, with the figure export's settings, which
 * `figure-export.set` changes), the highlighted cells of a page as an
 * obs-column CSV or an `.h5ad` subset (`cells.export`), and a column of the
 * cells as an obs-column CSV (`field.export`): the same files the Figure
 * export's Download, the Highlights list's export buttons and a field's
 * Export make, through the same code.
 *
 * Each is effect `outside` (it records no step and changes no state) and
 * asks the person before an agent writes it (`confirm: 'writes-file'`). A
 * file goes to the person through the browser's download, which needs no
 * click of theirs; what an agent is told is the file's name, its size and
 * counts, never a value of a cell, so the switch "Agents see names and
 * summaries only" keeps nothing of it from the agent
 * (`app/agent/bridge/data-guard.js`): a file the person receives is not
 * sent to the agent's provider.
 *
 * Implementations: `ui/modules/figure-export/figure-export-ui.js` (the
 * Download button's path) and `ui/modules/cell-exports-ui.js` (the export
 * buttons' path, with its card, its Cancel and its estimate of an `.h5ad`
 * subset's reading).
 *
 * @module app/actions/definitions/exports
 */

import { defineAction } from '../catalog.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { PAGE } from './params.js';

const GROUP = 'Exports';

const COUNT = Object.freeze({ type: 'integer', minimum: 0 });

/** A column of the cells by name (the export buttons take columns of the cells, not genes). */
const OBS_FIELD = Object.freeze({
  type: 'object', additionalProperties: false, required: ['source', 'key'],
  description: 'A column of the cells by name (source "obs"), categorical or continuous.',
  properties: {
    source: { type: 'string', const: 'obs', description: 'A column of the cells.' },
    key: { type: 'string', minLength: 1, description: 'The column name as the app shows it.' },
  },
  examples: [{ source: 'obs', key: 'cell_type' }],
});

/** The files a figure export writes (its Download menu's formats, as `figure-export.set` names them). */
const FIGURE_FILES = Object.freeze({
  type: 'array', description: 'The figures written: one file, or several in one ZIP archive.',
  items: {
    type: 'object', additionalProperties: false, required: ['format', 'file', 'dpi'],
    properties: {
      format: { enum: ['svg', 'png'] },
      file: { type: 'string', description: 'Its name.' },
      dpi: { type: ['integer', 'null'], description: 'A PNG\'s resolution; null for an SVG.' },
    },
  },
});

export const exportActions = Object.freeze([
  defineAction({
    type: 'figure.export',
    title: 'Export the figure',
    summary: 'Write the figure of the view shown (every view in a grid when the settings say so) as its Download button does, with the figure export\'s settings as they are (figure_export_set changes them: format, size, labels, legend, style): one SVG or PNG file, or several in one ZIP archive (view.picture with source "export" shows that figure first, nothing written). Refused, saying why, when the figure cannot reproduce what the view shows (a render mode other than points, an overlay it cannot draw).',
    group: GROUP,
    params: { type: 'object', additionalProperties: false, properties: {} },
    reads: [],
    effect: 'outside',
    confirm: 'writes-file',
    acts: { one: 'figure written', other: 'figures written' },
    result: {
      type: 'object', additionalProperties: false, required: ['files', 'zip'],
      properties: {
        files: FIGURE_FILES,
        zip: { type: 'boolean', description: 'The files were written in one ZIP archive (several formats or resolutions).' },
      },
    },
    describe: () => 'Exported the figure',
    code: () => 'export_figure()',
  }),
  defineAction({
    type: 'cells.export',
    title: 'Export the highlighted cells',
    summary: 'Write the highlighted cells of a highlight page as a file, as the Highlights list\'s export buttons do: an obs-column CSV (every open cell, a true/false column per highlight, which cellucid.pull() in Python and cellucid_pull() in R read back) or an .h5ad subset of the highlighted cells with their expression rows. The .h5ad reads the cells\' expression first; its time and bytes are estimated from this connection before it starts.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        page: { ...PAGE, description: 'The highlight page; the page shown when left out.' },
        format: { enum: ['csv', 'h5ad'], default: 'csv', description: 'csv: the obs-column CSV; h5ad: an AnnData file of the highlighted cells.' },
      },
    },
    reads: [],
    effect: 'outside',
    confirm: 'writes-file',
    acts: { one: 'file written', other: 'files written' },
    result: {
      type: 'object', additionalProperties: false, required: ['file', 'bytes', 'format', 'page', 'cells', 'renamed'],
      properties: {
        file: { type: 'string', description: 'The file written.' },
        bytes: COUNT,
        format: { enum: ['csv', 'h5ad'] },
        page: { type: 'string', description: 'The highlight page exported.' },
        cells: { ...COUNT, description: 'Cells highlighted on it.' },
        renamed: {
          type: 'array', description: 'Names an .h5ad cannot hold as they are, written under other names.',
          items: { type: 'object', additionalProperties: false, required: ['key', 'name'], properties: { key: { type: 'string' }, name: { type: 'string' } } },
        },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Exported the highlighted cells${params.page === undefined ? '' : ` of ${quote.bare(params.page)}`} as ${params.format === 'h5ad' ? '.h5ad' : 'CSV'}`,
    code: params => `export_cells(${[
      params.page === undefined ? null : `page=${JSON.stringify(params.page)}`,
      params.format === undefined || params.format === 'csv' ? null : `format=${JSON.stringify(params.format)}`,
    ].filter(Boolean).join(', ')})`,
  }),
  defineAction({
    type: 'field.export',
    title: 'Export a field',
    summary: 'Write a column of the cells (categorical or continuous) as an obs-column CSV, as its Export button in Color by does: every open cell and its value, which cellucid.pull() in Python and cellucid_pull() in R read back.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false, required: ['field'],
      properties: { field: OBS_FIELD },
    },
    reads: [],
    effect: 'outside',
    confirm: 'writes-file',
    acts: { one: 'file written', other: 'files written' },
    result: {
      type: 'object', additionalProperties: false, required: ['file', 'bytes', 'field', 'kind'],
      properties: {
        file: { type: 'string', description: 'The file written.' },
        bytes: COUNT,
        field: { type: 'string', description: 'The field exported.' },
        kind: { enum: ['categorical', 'continuous'] },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Exported ${quote.bare(params.field.key)} as CSV`,
    code: params => `export_field(${JSON.stringify(params.field.key)})`,
  }),
]);
