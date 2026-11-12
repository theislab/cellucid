/**
 * @fileoverview Every action definition, one module per area. Adding an area
 * is one import and one spread here; the catalog, the agent tools, the
 * protocol document, Python, R and the docs follow from it.
 *
 * @module app/actions/definitions
 */

import { historyActions } from './history.js';
import { fieldActions } from './fields.js';
import { coloringActions } from './coloring.js';
import { filterActions } from './filters.js';
import { mappingActions } from './mapping.js';
import { highlightActions } from './highlights.js';
import { viewActions } from './views.js';
import { cameraActions } from './camera.js';
import { settingsActions } from './settings.js';
import { layoutActions } from './layout.js';
import { readActions } from './reads.js';
import { analysisActions } from './analysis.js';
import { datasetActions } from './datasets.js';
import { storedActions } from './stored.js';
import { exportActions } from './exports.js';
import { annotationActions } from './annotation.js';

export const ACTION_DEFINITIONS = Object.freeze([
  ...historyActions,
  ...fieldActions,
  ...coloringActions,
  ...filterActions,
  ...mappingActions,
  ...highlightActions,
  ...viewActions,
  ...cameraActions,
  ...settingsActions,
  ...layoutActions,
  ...readActions,
  ...analysisActions,
  ...datasetActions,
  ...storedActions,
  ...exportActions,
  ...annotationActions,
]);
