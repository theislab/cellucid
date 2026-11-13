/**
 * @fileoverview What this browser keeps for later visits, as the Stored
 * dialog (Session › Open data › Stored › Manage…) lists and removes it:
 * `stored.list` (a read) and `stored.remove` (effect `outside`, asked of an
 * agent as `deletes-saved`: nothing the history holds changes, and nothing
 * brings it back).
 *
 * Kept per dataset: converted copies, whole downloads, downloaded parts and
 * gene indexes (`data/anndata/transcode/space.js`), each by its id, an item
 * an open tab uses staying until that tab closes; then the saved states of
 * histories, My datasets, the connection speeds remembered per host and the
 * decoder choices, each one row. One saved state is deleted by
 * `history.saved.delete`, one dataset of My datasets is forgotten by
 * `my-datasets.forget`.
 *
 * The implementation is the dialog's own (`ui/modules/kept-stores-dialog.js`:
 * the one listing and the one removal its buttons use).
 *
 * @module app/actions/definitions/stored
 */

import { defineAction } from '../catalog.js';

const GROUP = 'Stored';
const COUNT = Object.freeze({ type: 'integer', minimum: 0 });
const NULLABLE_COUNT = Object.freeze({ type: ['integer', 'null'], minimum: 0 });

/** Whether an open tab uses a kept item (then it stays until that tab closes). */
const STORED_HELD = Object.freeze(['none', 'this-tab', 'other-tab']);

const ITEM = Object.freeze({
  type: 'object', additionalProperties: false, required: ['id', 'kind', 'what', 'bytes', 'last_used', 'in_use', 'saves'],
  properties: {
    id: { type: 'string', description: 'Its id (stored_remove takes it).' },
    kind: { type: 'string', description: 'converted (a converted copy), download (a whole download), parts (downloaded parts), gene-index, or another kind.' },
    what: { type: 'string', description: 'What it is, as the dialog says it.' },
    bytes: COUNT,
    last_used: { type: ['string', 'null'], description: 'When it was last used (ISO 8601), or null.' },
    in_use: { enum: [...STORED_HELD], description: 'Whether an open tab uses it: it can be removed once that tab closes.' },
    saves: { ...NULLABLE_COUNT, description: 'Bytes it spares the next opening, when known.' },
  },
});

export const storedActions = Object.freeze([
  defineAction({
    type: 'stored.list',
    title: 'List what this browser keeps',
    summary: 'Everything kept in this browser for later visits, as the Stored dialog lists it: per dataset (its file\'s name and host) the converted copies, downloads, downloaded parts and gene indexes with their sizes; then the saved states, My datasets, the connection speeds and the decoder choices; and how much room the browser gives the site.',
    group: GROUP,
    params: { type: 'object', additionalProperties: false, properties: {} },
    reads: [],
    effect: 'read',
    result: {
      type: 'object', additionalProperties: false,
      required: ['datasets', 'saved_states', 'my_datasets', 'connection_speeds', 'decoder_choices', 'bytes', 'room'],
      properties: {
        datasets: {
          type: 'array', description: 'Most recently used first.',
          items: {
            type: 'object', additionalProperties: false, required: ['name', 'host', 'bytes', 'items'],
            properties: {
              name: { type: 'string', description: 'Its file\'s name.' },
              host: { type: 'string', description: 'Where it is read from, or "this computer".' },
              bytes: COUNT,
              items: { type: 'array', items: ITEM },
            },
          },
        },
        saved_states: {
          type: 'object', additionalProperties: false, required: ['count', 'bytes'],
          description: 'The histories kept in this browser (history_saved_list lists each).',
          properties: { count: COUNT, bytes: COUNT },
        },
        my_datasets: {
          type: 'object', additionalProperties: false, required: ['count', 'files'],
          description: 'The datasets opened in this browser (datasets_list lists each) and the files of this computer among them it can reopen.',
          properties: { count: COUNT, files: COUNT },
        },
        connection_speeds: { ...COUNT, description: 'Hosts whose connection speed is remembered.' },
        decoder_choices: { ...COUNT, description: 'Decoder choices measured in this browser.' },
        bytes: { ...COUNT, description: 'What the kept items and saved states take.' },
        room: {
          type: 'object', additionalProperties: false, required: ['usage', 'quota', 'kept_when_space_is_low'],
          description: 'What the browser says of the site\'s storage.',
          properties: {
            usage: { ...NULLABLE_COUNT, description: 'Bytes the site uses, when the browser says.' },
            quota: { ...NULLABLE_COUNT, description: 'Bytes the browser lets the site use, when it says.' },
            kept_when_space_is_low: { type: ['boolean', 'null'], description: 'Whether the browser keeps it when the disk runs low, when it says.' },
          },
        },
      },
    },
    describe: () => 'Listed what this browser keeps',
    code: () => 'stored_list()',
  }),
  defineAction({
    type: 'stored.remove',
    title: 'Remove what this browser keeps',
    summary: 'Remove what the Stored dialog removes: kept items by id, all a dataset\'s kept items, every saved state, My datasets (the list and the files\' handles), the connection speeds, the decoder choices, or everything (Remove all). An item an open tab uses stays until that tab closes. Nothing brings it back; the dataset opens again more slowly the first time.',
    group: GROUP,
    params: {
      type: 'object', additionalProperties: false,
      properties: {
        items: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, uniqueItems: true, examples: [['parts:3f2a…']], description: 'Kept items by id (stored_list).' },
        dataset: { type: 'string', minLength: 1, examples: ['pancreas.h5ad'], description: 'Every kept item of the dataset with this file name (stored_list).' },
        saved_states: { type: 'boolean', default: false, description: 'Every saved state of this browser (history_saved_delete deletes one).' },
        my_datasets: { type: 'boolean', default: false, description: 'My datasets: the list and the handles of its files (my_datasets_forget forgets one).' },
        connection_speeds: { type: 'boolean', default: false, description: 'The connection speeds remembered per host.' },
        decoder_choices: { type: 'boolean', default: false, description: 'The decoder choices measured in this browser.' },
        everything: { type: 'boolean', default: false, description: 'Everything no open tab uses, as Remove all.' },
      },
    },
    reads: [],
    effect: 'outside',
    confirm: 'deletes-saved',
    acts: { one: 'removal of stored data', other: 'removals of stored data' },
    result: {
      type: 'object', additionalProperties: false,
      required: ['removed', 'held', 'saved_states', 'my_datasets', 'connection_speeds', 'decoder_choices', 'said'],
      properties: {
        removed: { ...COUNT, description: 'Kept items removed.' },
        held: { ...COUNT, description: 'Kept items that stay, in use by an open tab.' },
        saved_states: { ...COUNT, description: 'Saved states deleted.' },
        my_datasets: { ...COUNT, description: 'Datasets forgotten from My datasets.' },
        connection_speeds: { ...COUNT, description: 'Hosts whose connection speed was forgotten.' },
        decoder_choices: { ...COUNT, description: 'Decoder choices forgotten.' },
        said: { type: 'string', description: 'What the dialog says of it.' },
      },
    },
    describe: params => (params.everything === true ? 'Removed everything this browser keeps' : 'Removed what this browser keeps'),
    code: params => `stored_remove(${Object.entries(params).filter(([, value]) => value !== undefined && value !== false)
      .map(([key, value]) => `${key}=${value === true ? 'True' : JSON.stringify(value)}`).join(', ')})`,
  }),
]);
