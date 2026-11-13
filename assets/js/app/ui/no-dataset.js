/**
 * @fileoverview What every part of Cellucid says while no dataset is open:
 * one fact, one verb ("Open", as the Open data block names it, never "Load",
 * which is the session file's) and one place to do it.
 *
 * The same state has one wording everywhere, not "No dataset selected", "No
 * dataset loaded", "No dataset is open yet.", "Load a dataset to …", "Open a
 * dataset before …" or "History starts when …" in different panels, and no
 * place names a wrong cause ("Requires gene expression data.", "No neighbor
 * graph available for this dataset"). Contract:
 * `tests/no-dataset-wording-contract.test.mjs`.
 *
 * @module ui/no-dataset
 */

import { PLACES, placePath } from './place-names.js';

/** The fact, as a sentence: a refusal's start, an empty state. */
export const NO_DATASET_OPEN = 'No dataset is open.';

/** The fact as a name: the dataset card's and the phone sheet's name line. */
export const NO_DATASET_LABEL = 'No dataset open';

/** Where a person opens a dataset. */
export const OPEN_DATASET_PLACE = placePath(PLACES.session, PLACES.openData);

/** The history's own line and refusal while no dataset is open. */
export const HISTORY_WAITS_FOR_DATASET = 'The history starts once a dataset is open.';

/**
 * Why a control is off for want of a dataset (its title): "Open a dataset to
 * keep views."
 *
 * @param {string} purpose - What the control does, as a verb phrase
 * @returns {string}
 */
export function openADatasetTo(purpose) {
  return `Open a dataset to ${purpose}.`;
}

/**
 * A refusal or an empty state that says the fact and the way on: "No dataset
 * is open. Open one in Session › Open data to analyze it."
 *
 * @param {string} purpose - What waits for the dataset, as a verb phrase
 * @returns {string}
 */
export function noDatasetOpenTo(purpose) {
  return `${NO_DATASET_OPEN} Open one in ${OPEN_DATASET_PLACE} to ${purpose}.`;
}
