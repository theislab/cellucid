/**
 * The dataset controls' intent owner, reduced to what the dataset
 * connections use: a real dataset-change coordinator plus the activation a
 * test observes. `activateDataset(datasetId, sourceType, loadMethod, source)`
 * stands in for the controls' reload.
 */
import {
  createLatestDatasetReloadCoordinator
} from '../../assets/js/app/dataset-reload-outcome.js';

export function createTestDatasetIntents(activateDataset) {
  const changes = createLatestDatasetReloadCoordinator(() => ({
    baseUrl: null,
    datasetId: null,
    selectionIdentity: null,
    source: null,
  }));
  let active = null;
  const adopt = (transaction, pending) => {
    const intent = Object.freeze({ pending, transaction });
    active = intent;
    return intent;
  };
  return Object.freeze({
    activate: (_intent, datasetId, sourceType, loadMethod, source) =>
      activateDataset(datasetId, sourceType, loadMethod, source),
    actionSequence: () => changes.actionSequence,
    begin: pending => adopt(changes.begin(), pending),
    beginIfNoActionSince(sequence, pending) {
      const transaction = changes.beginIfNoActionSince(sequence);
      return transaction === null ? null : adopt(transaction, pending);
    },
    changes,
    owns: intent => intent === active && intent.transaction.isLatest(),
    settle(intent) {
      intent.transaction.finish();
      if (active === intent) active = null;
    },
    settled: () => changes.settled,
    whenSettled: () => changes.whenSettled(),
  });
}
