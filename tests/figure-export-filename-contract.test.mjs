/**
 * An exported figure's filename names the dataset, the colour field, the view
 * and the time. A view nobody renamed carries its colour field as its label,
 * so the field used to appear twice: `Atlas_cell_type_cell_type_<ts>.png`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExportFilename,
} from '../assets/js/app/ui/modules/figure-export/utils/export-helpers.js';

const timestamp = '20261018_120000';

test('a view labelled with its own colour field is named once', () => {
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
});
