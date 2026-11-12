/**
 * @fileoverview The records of every state domain's value, declared once
 * (round 9 close, the class of F244 and F181): each record's required,
 * optional, added and dropped keys (`record-keys.js`). The state domains read
 * every value they restore or describe through these (`index.js`
 * `installStateDomains`), so a value written before a key was added or
 * dropped still reads, and only a truly wrong record is refused, naming
 * where it is wrong.
 *
 * Adding a key to a domain's record: add it here as `added` with the value
 * its absence means (its writer leaves it out at that value, so the records
 * of before hash as they did); dropping one: move it to `dropped`.
 * `tests/state-record-added-keys.test.mjs` reads every published starting
 * view and an older saved state through every shape here.
 *
 * A record whose keys another module owns and reads exactly is that
 * module's (its shape stops at it): a view's `embedding` (the data
 * mapping's representation reader), a camera state's parts beyond its three
 * keys (`rendering/camera-state-contract.js`), the analyses' windows and
 * modes (the analysis tools), a user field (`field-overlays.js`, whose items
 * name their kind's keys), the data mapping (`data/data-mapping.js`, a
 * contract with Python and R), the settings (read one control at a time,
 * F181) and the Camera Path's own state (`cinematic-camera`, R9R-13).
 *
 * @module app/state/domains/records
 */

import { listOf, nullable, record } from './record-keys.js';

/** A field by name: a dataset field `{source, key}` or a user field `{source, user}` (`fields.js` `fieldRef`). */
const FIELD_REF = record({ required: ['source'], optional: ['key', 'user'] });

/** A range of values. */
const RANGE = record({ required: ['min', 'max'] });

/** A box on the page, in pixels. */
const RECT = record({ required: ['left', 'top', 'width', 'height'] });

/** A subsample's specification (`cells.js` `SPEC_KEYS`): each part written only when it has one. */
const OPEN_CELLS = record({
  optional: ['method', 'k', 'seed', 'blockSize', 'field', 'allocation', 'minPerCategory', 'embedding', 'columns', 'gridSize'],
});

/** A view's camera (`rendering/camera-state-contract.js`, which reads its parts exactly). */
const CAMERA_STATE = record({ required: ['navigationMode', 'orbit', 'freefly'] });

/** One field's filter of one view (`filters.js` `captureFieldFilter`). */
const FILTER = record({
  required: ['field'],
  optional: ['off', 'hidden', 'limits', 'missingHidden', 'outlier', 'outlierOff', 'range'],
  fields: {
    field: FIELD_REF,
    limits: listOf(record({ required: ['category', 'count', 'seed'] })),
    range: RANGE,
  },
});

/** One field's colors of one view (`colors.js` `captureFieldColors`). */
const COLORS = record({
  required: ['field'],
  optional: ['colors', 'colormap', 'range', 'log', 'rescale', 'zeroGray'],
  fields: {
    field: FIELD_REF,
    colors: listOf(record({ required: ['category', 'color'] })),
    range: RANGE,
  },
});

/** One highlight group (`highlights.js` `captureGroup`): a category's names its field and category, a range's its field and range. */
const HIGHLIGHT_GROUP = record({
  required: ['id', 'type', 'label', 'enabled', 'cells'],
  optional: ['field', 'category', 'range'],
  fields: { field: record({ required: ['source', 'key'] }), range: RANGE },
});

/**
 * Each domain's value, by domain id; a domain not named here (`mapping`,
 * `settings`, `camera-path`) is read whole by the module that owns its
 * record (module overview).
 */
export const RECORDS = Object.freeze({
  cells: record({ required: ['open', 'genes'], fields: { open: nullable(OPEN_CELLS) } }),
  expression: record({ required: ['normalize', 'log1p'] }),
  'field-overlays': record({
    required: ['renamedFields', 'renamedCategories', 'deletedFields', 'userFields'],
    fields: {
      renamedFields: listOf(record({ required: ['source', 'key', 'name'] })),
      renamedCategories: listOf(record({ required: ['source', 'field', 'category', 'name'] })),
      deletedFields: listOf(record({ required: ['source', 'key', 'purged'] })),
    },
  }),
  'gene-sets': record({ required: ['sets'], fields: { sets: listOf(record({ required: ['name', 'description', 'genes'] })) } }),
  views: record({
    required: ['layout', 'focus', 'liveHidden', 'camerasLinked', 'views'],
    fields: {
      views: listOf(record({
        required: ['embedding', 'followsDefault', 'centroids'],
        optional: ['name'],
        fields: { centroids: record({ required: ['points', 'labels'] }) },
      })),
    },
  }),
  'active-field': record({ required: ['views'], fields: { views: listOf(nullable(FIELD_REF)) } }),
  filters: record({ required: ['views'], fields: { views: listOf(listOf(FILTER)) } }),
  colors: record({ required: ['views'], fields: { views: listOf(listOf(COLORS)) } }),
  visibility: record({ required: ['views'] }),
  highlights: record({
    required: ['active', 'pages'],
    fields: { pages: listOf(record({ required: ['id', 'name', 'color', 'groups'], fields: { groups: listOf(HIGHLIGHT_GROUP) } })) },
  }),
  camera: record({ required: ['views'], fields: { views: listOf(CAMERA_STATE) } }),
  analysis: record({
    required: ['windows', 'docked'],
    // The sizes remembered per analysis moved to the layout (2026-11-06): a saved state of before holds them here.
    dropped: ['sizes'],
    fields: { docked: nullable(record({ required: ['openMode', 'modes'] })) },
  }),
  layout: record({
    required: ['theme', 'sections', 'panels', 'analysis', 'sidebar'],
    fields: {
      panels: listOf(record({ required: ['id', 'rect'], fields: { rect: RECT } })),
      analysis: record({ required: ['windows', 'sizes'], fields: { windows: listOf(record({ required: ['rect', 'open'], fields: { rect: RECT } })) } }),
      sidebar: record({ required: ['open', 'width'] }),
    },
  }),
});
