/**
 * Stage, commit, publish and finalize one dataset selection on a real
 * DataSourceManager — the order a dataset activation drives it in
 * (`reloadActiveDatasetInPlace` in `app/main.js`), without the runtime
 * staging between commit and publication.
 */
export async function selectDataset(manager, sourceType, datasetId, options = {}) {
  const stage = await manager.stageDatasetSelection(
    sourceType,
    datasetId,
    options
  );
  const publication = manager.commitDatasetSelection(stage);
  manager.publishDatasetSelection(publication);
  manager.finalizeDatasetSelection(publication);
  return stage;
}
