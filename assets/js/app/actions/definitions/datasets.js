/**
 * @fileoverview Which dataset is open: the datasets an agent can open by the
 * name the person gives (`datasets.list`, a read, with what My datasets › All…
 * shows of each one's size) and opening one (`dataset.open`, effect
 * `dataset`); forgetting one of My datasets (`my-datasets.forget`, effect
 * `outside`, asked as `deletes-saved`: its Forget in All…, provided by
 * `ui/modules/my-datasets/index.js`); and the public link that opens the
 * dataset shown for anyone (`dataset.share-link`, effect `outside`, asked as
 * `publishes`: Share in Open data, provided by `ui/modules/share-dialog.js`).
 *
 * Opening a dataset replaces the open one, as choosing it in Session › Open
 * data does: the open dataset's history stays kept in this browser (State ›
 * Saved states, My datasets › Continue) and the new one starts its own. So
 * it is not a step of either history and touches no domain; the agent's turn
 * on the dataset it leaves ends there. A download of a whole file (a host
 * that serves no parts of it) is asked about first when an agent opens it
 * (`confirm: 'large-download'`, asked by the implementation once the link
 * says how big it is: `confirmAt: 'handler'`); a copy this browser kept is
 * not downloaded again and not asked about.
 *
 * The implementation is the Open data controls'
 * (`app/ui/modules/dataset-open-action.js`), through the paths the person's
 * own choices take; names resolve through `app/actions/targets/datasets.js`.
 *
 * @module app/actions/definitions/datasets
 */

import { defineAction } from '../catalog.js';
import { PLAIN_QUOTE } from '../targets/names.js';
import { PLACES, placePath } from '../../ui/place-names.js';

/** Where a name is looked for. */
export const DATASET_NAME_KINDS = Object.freeze(['any', 'sample', 'my-datasets', 'link']);

const COUNT = Object.freeze({ type: 'integer', minimum: 0 });
const NULLABLE_COUNT = Object.freeze({ type: ['integer', 'null'], minimum: 0 });

const DATASET_KIND = Object.freeze({
  type: 'string', enum: ['sample', 'link', 'server', 'file', 'folder', 'notebook'],
  description: 'Where it opens from: a built-in sample, a link, a Cellucid server, a file or folder of the person\'s computer, or a notebook (Python, R) that serves it.',
});

export const datasetActions = Object.freeze([
  defineAction({
    type: 'datasets.list',
    title: 'List the datasets to open',
    summary: 'The datasets this tab can open by name: the built-in samples and the person\'s own datasets opened before in this browser (My datasets, each with its size and what this browser keeps of it), with the one open now.',
    group: 'Datasets',
    params: { type: 'object', additionalProperties: false, properties: {} },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false, required: ['open', 'samples', 'my_datasets'],
      properties: {
        open: {
          oneOf: [
            {
              type: 'object', additionalProperties: false, required: ['name', 'kind'],
              properties: { name: { type: 'string' }, kind: DATASET_KIND },
            },
            { type: 'null' },
          ],
          description: 'The dataset open now, or null.',
        },
        samples: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['name', 'id', 'cells', 'genes'],
            properties: {
              name: { type: 'string' },
              id: { type: 'string', description: 'Its id in the sample list; a name too.' },
              cells: NULLABLE_COUNT,
              genes: NULLABLE_COUNT,
            },
          },
        },
        my_datasets: {
          type: 'array',
          description: 'Most recently opened first.',
          items: {
            type: 'object', additionalProperties: false,
            required: ['name', 'kind', 'cells', 'genes', 'last_opened', 'saved_states', 'size', 'saved_states_bytes', 'kept_bytes', 'agent_can_open'],
            properties: {
              name: { type: 'string' },
              kind: DATASET_KIND,
              cells: NULLABLE_COUNT,
              genes: NULLABLE_COUNT,
              last_opened: { type: 'string', description: 'When it was last opened (ISO 8601).' },
              saved_states: { ...COUNT, description: 'Histories of it kept in this browser.' },
              size: { ...NULLABLE_COUNT, description: 'The size of its file or store in bytes, when known.' },
              saved_states_bytes: { ...COUNT, description: 'Bytes its saved states take in this browser.' },
              kept_bytes: { ...COUNT, description: 'Bytes this browser keeps of it for faster openings (stored_list lists them).' },
              agent_can_open: {
                type: 'boolean',
                description: `False for a file or folder the browser lets only the person open again (they choose it in ${PLACES.myDatasets.name}).`,
              },
            },
          },
        },
      },
    },
    describe: () => 'Listed the datasets to open',
    code: () => 'list_datasets()',
  }),
  defineAction({
    type: 'dataset.open',
    title: 'Open a dataset',
    summary: 'Open a dataset by the name the person gives: a built-in sample, one of their datasets (My datasets), a link, or an accession the link box takes. It replaces the open dataset; that one\'s history stays kept in this browser and the new one starts its own. A whole-file download is asked about first.',
    group: 'Datasets',
    params: {
      type: 'object', additionalProperties: false, required: ['name'],
      properties: {
        name: {
          type: 'string', minLength: 1, examples: ['Pancreatic endocrinogenesis (scVelo)'],
          description: 'A sample\'s name or id, a name from My datasets, a link to a dataset (a file, a Zarr store, a dataset folder, a CELLxGENE, Zenodo, Figshare or GitHub address), an accession (GSE123456, a DOI), or a Cellucid server (localhost:8765).',
        },
        kind: {
          type: 'string', enum: DATASET_NAME_KINDS, default: 'any',
          description: 'Where to look for the name: any (samples, then My datasets, then as a link), sample, my-datasets or link.',
        },
      },
    },
    reads: [],
    effect: 'dataset',
    confirm: 'large-download',
    confirmAt: 'handler',
    result: {
      type: 'object', additionalProperties: false,
      required: ['name', 'kind', 'cells', 'total_cells', 'genes', 'saved_states', 'already_open'],
      properties: {
        name: { type: 'string', description: 'The dataset now open, as Cellucid names it.' },
        kind: DATASET_KIND,
        cells: { ...COUNT, description: 'The cells open (a share of the dataset when it is subsampled).' },
        total_cells: COUNT,
        genes: NULLABLE_COUNT,
        saved_states: { ...COUNT, description: 'Histories of this dataset kept in this browser from earlier visits; the person was offered to continue the latest.' },
        already_open: { type: 'boolean', description: 'It was open already, so nothing was opened again and its history goes on.' },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Opened ${quote.bare(params.name)}`,
    code: params => (params.kind === 'any' || params.kind === undefined
      ? `open_dataset(${JSON.stringify(params.name)})`
      : `open_dataset(${JSON.stringify(params.name)}, kind=${JSON.stringify(params.kind)})`),
  }),
  defineAction({
    type: 'my-datasets.forget',
    title: 'Forget a dataset of My datasets',
    summary: `Remove one dataset from ${PLACES.myDatasets.name}, as its Forget in ${PLACES.myDatasets.name} › All… does: the entry and, for a file or folder of this computer, the browser's handle of it; its saved states only when asked. The dataset itself is not touched, and nothing brings the entry back but opening it again.`,
    group: 'Datasets',
    params: {
      type: 'object', additionalProperties: false, required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, examples: ['Pancreatic endocrinogenesis (scVelo)'], description: `Its name in ${PLACES.myDatasets.name} (datasets_list).` },
        saved_states: { type: 'boolean', default: false, description: 'Also delete its saved states (histories kept in this browser).' },
      },
    },
    reads: [],
    effect: 'outside',
    confirm: 'deletes-saved',
    acts: { one: 'dataset forgotten', other: 'datasets forgotten' },
    result: {
      type: 'object', additionalProperties: false, required: ['name', 'handles', 'saved_states'],
      properties: {
        name: { type: 'string', description: 'The dataset forgotten.' },
        handles: { ...COUNT, description: 'Handles of files of this computer forgotten with it.' },
        saved_states: { ...COUNT, description: 'Its saved states deleted.' },
      },
    },
    describe: (params, outcome, quote = PLAIN_QUOTE) => `Forgot ${quote.bare(params.name)} in ${PLACES.myDatasets.name}`,
    code: params => (params.saved_states === true
      ? `forget_dataset(${JSON.stringify(params.name)}, saved_states=True)`
      : `forget_dataset(${JSON.stringify(params.name)})`),
  }),
  defineAction({
    type: 'dataset.share-link',
    title: 'Make a share link',
    summary: `The public link that opens the dataset shown on www.cellucid.com for anyone, with its "Open in Cellucid" badge and an embed snippet, as Share in ${placePath(PLACES.session, PLACES.openData)} makes them; what a link carried to grant access is left out. Refused for a dataset no link reopens (a file of this computer, a notebook's, a server on this computer).`,
    group: 'Datasets',
    params: { type: 'object', additionalProperties: false, properties: {} },
    reads: [],
    effect: 'outside',
    confirm: 'publishes',
    acts: { one: 'share link published', other: 'share links published' },
    result: {
      type: 'object', additionalProperties: false, required: ['link', 'badge', 'embed', 'access_left_out'],
      properties: {
        link: { type: 'string', description: 'The link.' },
        badge: { type: 'string', description: 'The badge as Markdown.' },
        embed: { type: 'string', description: 'The embed snippet as HTML.' },
        access_left_out: { type: 'boolean', description: 'The dataset\'s link carried a key, a signature or a token that was left out: someone without access cannot open it.' },
      },
    },
    describe: () => 'Made a share link',
    code: () => 'share_link()',
  }),
]);
