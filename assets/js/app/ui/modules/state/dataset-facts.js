/**
 * @fileoverview The facts about the dataset shown that a shared history
 * names: its name and identity, its cells and genes, its citation, and the
 * cells open when they are a subsample (how many, how chosen, the seed).
 *
 * @module ui/modules/state/dataset-facts
 */

/**
 * @param {{state: object, dataSourceManager: object|null}} owners
 * @returns {() => {name: string|null, id: string|null, cells: number|null, genes: number|null,
 *   citation: string|null, openCells: {open: number, of: number, method: string|null, seed: number|null}|null}}
 */
export function datasetFactsOf({ state, dataSourceManager }) {
  return () => {
    const metadata = dataSourceManager?.getCurrentMetadata?.() ?? null;
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() ?? null;
    const sourceType = dataSourceManager?.getCurrentSourceType?.() ?? null;
    const identity = state.cellIdentity ?? null;
    const annData = sourceType === null || datasetId === null
      ? null
      : dataSourceManager?.getSource?.(sourceType)?.getAnnDataSource?.(datasetId) ?? null;
    const spec = identity?.isSubset && typeof annData?.getCellSubset === 'function'
      ? annData.getCellSubset()?.spec ?? null
      : null;
    const finite = value => (Number.isFinite(value) ? value : null);
    return {
      name: metadata?.name ?? null,
      id: datasetId,
      cells: finite(identity?.nOriginal ?? metadata?.stats?.n_cells),
      genes: finite(metadata?.stats?.n_genes),
      citation: metadata?.source?.citation ?? null,
      openCells: identity?.isSubset
        ? {
          open: identity.n,
          of: identity.nOriginal,
          method: typeof spec?.method === 'string' ? spec.method : null,
          seed: Number.isSafeInteger(spec?.seed) ? spec.seed : null,
        }
        : null,
    };
  };
}
