/**
 * An exported figure's filename names the dataset, the color field, the view
 * and the time. A view nobody renamed carries its color field as its label,
 * so the field must not appear twice: `Atlas_cell_type_cell_type_<ts>.png`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExportFilename,
} from '../assets/js/app/ui/modules/figure-export/utils/export-helpers.js';

const timestamp = '20261018_120000';

test('a view labelled with its own color field is named once', () => {
  assert.equal(
    buildExportFilename({
      datasetName: 'Atlas',
      fieldKey: 'cell_type',
      viewLabel: 'cell_type',
      variant: null,
      ext: 'png',
      timestamp,
    }),
    'Atlas_cell_type_20261018_120000.png',
  );
});

test('a renamed view, a grid, and a DPI tag keep their own segments', () => {
  assert.equal(
    buildExportFilename({
      datasetName: 'Atlas',
      fieldKey: 'cell_type',
      viewLabel: 'Treated',
      variant: 'dpi300',
      ext: 'png',
      timestamp,
    }),
    'Atlas_cell_type_Treated_dpi300_20261018_120000.png',
  );
  assert.equal(
    buildExportFilename({
      datasetName: 'Atlas',
      fieldKey: 'cell_type',
      viewLabel: 'multiview',
      variant: null,
      ext: 'svg',
      timestamp,
    }),
    'Atlas_cell_type_multiview_20261018_120000.svg',
  );
  assert.equal(
    buildExportFilename({
      datasetName: 'Atlas',
      fieldKey: null,
      viewLabel: 'multiview',
      variant: null,
      ext: 'svg',
      timestamp,
    }),
    'Atlas_multiview_20261018_120000.svg',
  );
  // A view labeled with a filter of the colored field names the field once (not
  // "…Suo_cell_type_cell_type_cell_type_hiding_AXL…png").
  assert.equal(
    buildExportFilename({
      datasetName: 'Developing human immune system (Suo)',
      fieldKey: 'cell_type',
      viewLabel: 'cell_type: hiding AXL+ and SIGLEC6+ DCs',
      variant: null,
      ext: 'png',
      timestamp,
    }),
    'Developing_human_immune_system_Suo_cell_type_hiding_AXL_and_SIGLEC6_DCs_20261018_120000.png',
  );
  // A field that only begins another word is still written.
  assert.equal(
    buildExportFilename({ datasetName: 'Atlas', fieldKey: 'type', viewLabel: 'types view', variant: null, ext: 'png', timestamp }),
    'Atlas_type_types_view_20261018_120000.png',
  );
});
