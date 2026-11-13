/**
 * The reader's description of the open dataset for the data mapping and the
 * page: what each element is (`probeMapping`, `probe.js`), what the default
 * expression matrix holds (`_probeExpression`), and the dataset metadata the
 * page shows before any value is read.
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes no field.
 *
 * @module data/anndata/reader/mapping-probe
 */

import { defaultGraph, expressionRuleInputs } from '../../data-mapping.js';
import { isGroup } from '../../../formats/store.js';
import { child, requireMapping, validateDataFrame } from '../elements.js';
import { probeColumns, readDataFrameIndex } from '../dataframe.js';
import { readLog1pRecord } from '../uns.js';
import { storedMatrix, regionReader, storedValueFacts, probeElement } from '../probe.js';

export class AnnDataReaderMappingProbeMethods {
  /**
   * Describe, from metadata alone, every element the data-mapping catalog
   * lists: the `obsm` and `obsp` entries, the var columns, `X`, the layers
   * and `raw`, and, for a multimodal store, the same for each modality
   * (`modalities`, null for a store of one feature space). No array value
   * is read but `uns['log1p']` and, for a group with `raw`, the first chunk
   * of a dense float `X` (whether it is scaled, `defaultExpression`, the
   * read the opening made: `_openCells`), and, with `counts`, each matrix's
   * first stored values (`storedValueFacts`: whether it holds counts, and
   * whether they refute `uns['log1p']`; null for each without). The opening describes the file without them
   * (`getDatasetMetadata`): the first view reads no matrix value, and a
   * served store's matrix being laid out in the background never holds it
   * back; the data-mapping catalog is completed with them after it.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {{counts?: boolean}} [options]
   */
  async probeMapping({ counts = true } = {}) {
    this._ensureOpen();
    const root = this._root;
    const format = this._format;
    // What the catalog describes beyond what opening loaded: the graphs, an
    // `obsm` entry that is a group (a dataframe, a sparse matrix), and
    // `uns['log1p']`, of the root and of each modality.
    const probed = ['obsp', 'obsm', 'uns/log1p'];
    await root.load([...probed, ...[...(this._modalities?.keys() ?? [])].flatMap(name => probed.map(path => `mod/${name}/${path}`))]);
    const mappingProbes = name => {
      if (!root.has(name)) return [];
      const group = requireMapping(root.get(name), format, `${format.file} ${name} mapping`);
      return group.keys().map(key => probeElement(key, group.get(key)));
    };
    // Sparse matrices' stored values are probed in the store as it is held,
    // before a subsample's view (`storedValueFacts`).
    const stored = this._fullRoot ?? root;
    const expression = await this._probeExpression(root, format.file, stored, counts);
    let modalities = null;
    if (this._modalities !== null) {
      modalities = await Promise.all([...this._modalities.values()].map(async ({ modality }) => {
        const group = this._root.get(`mod/${modality.name}`);
        const probe = await this._probeExpression(group, `${format.file} modality '${modality.name}'`, stored.get(`mod/${modality.name}`), counts);
        return { name: modality.name, nCells: modality.nCells, ...probe };
      }));
    }
    // A subsample's graphs are stored on every cell and read as their induced
    // subgraph on the open cells (`readInducedGraph`): listed as that graph,
    // its stored entries unknown until it is read.
    const subsetRows = this._cellSubset?.rows ?? null;
    const openGraph = probe => (
      subsetRows !== null && probe.shape?.length === 2
        && probe.shape[0] === subsetRows.nOriginal && probe.shape[1] === subsetRows.nOriginal
        ? { ...probe, shape: [this._nObs, this._nObs], nnz: null }
        : probe
    );
    return {
      nObs: this._nObs,
      nVars: this._nVars,
      obsm: mappingProbes('obsm'),
      obsp: mappingProbes('obsp').map(openGraph),
      varColumns: expression.varColumns,
      X: expression.X,
      layers: expression.layers,
      raw: expression.raw,
      log1p: expression.log1p,
      modalities,
      defaultModality: this._defaultModality,
    };
  }

  /**
   * The expression side of one AnnData group (the root, or a modality's):
   * its var count and columns, `X`, layers, `raw` and `uns['log1p']`;
   * whether each matrix holds counts with `counts` (else null).
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  async _probeExpression(group, label, stored = group, counts = true) {
    // What each matrix's first stored values tell (`storedValueFacts`):
    // whether it holds counts and whether they refute `uns['log1p']`.
    const log1p = await readLog1pRecord(group, {});
    const factsOf = async (node, read, storedNode) => {
      const facts = counts ? await storedValueFacts(node, { read, stored: storedNode, log1pBase: log1p === null ? undefined : log1p.base }) : null;
      return { counts: facts?.counts ?? null, notLog1p: facts?.notLog1p ?? null };
    };
    const format = this._format;
    let raw = null;
    let rawShape = null;
    const rawGroup = child(group, 'raw');
    if (isGroup(rawGroup) && rawGroup.has('X')) {
      const rawX = probeElement('X', rawGroup.get('X'));
      rawShape = rawX.shape?.length === 2 ? rawX.shape : [0, 0];
      raw = {
        nVars: rawX.shape?.length === 2 ? rawX.shape[1] : 0,
        X: { storage: rawX.storage, dtype: rawX.dtype, ...await factsOf(rawGroup.get('X'), undefined, child(child(stored, 'raw'), 'X')) },
        varColumns: rawGroup.has('var') ? probeColumns(rawGroup.get('var'), format, `${label} raw.var`, rawX.shape?.length === 2 ? rawX.shape[1] : null) : [],
      };
    }
    let matrixX = null;
    let nVars = null;
    if (group.has('X')) {
      const node = group.get('X');
      const probe = probeElement('X', node);
      // Whether X is scaled decides between it and raw (`defaultExpression`):
      // asked only when there is a raw to choose.
      const read = regionReader(node);
      const scaled = raw === null || probe.shape?.length !== 2
        ? null
        : (await expressionRuleInputs({ X: storedMatrix(node, probe.shape), rawX: { shape: rawShape }, read })).xScaled;
      matrixX = { storage: probe.storage, dtype: probe.dtype, scaled, ...await factsOf(node, read, stored.get('X')) };
      nVars = probe.shape?.[1] ?? null;
    }
    const layers = group.has('layers')
      ? await Promise.all(requireMapping(group.get('layers'), format, `${label} layers mapping`).keys()
        .map(async key => {
          const node = group.get('layers').get(key);
          return { ...probeElement(key, node), ...await factsOf(node, undefined, stored.get('layers').get(key)) };
        }))
      : [];
    const varFrame = group.get('var');
    if (nVars === null) {
      const { indexKey } = validateDataFrame(varFrame, format, `${label} var`);
      nVars = (await readDataFrameIndex(varFrame.get(indexKey), format, `${label} var index`, null, false, {})).length;
    }
    return {
      nVars,
      varColumns: probeColumns(varFrame, format, `${label} var`, nVars),
      X: matrixX,
      layers,
      raw,
      log1p,
    };
  }

  /**
   * What the page shows of the dataset before any value is read: its title,
   * `uns['cellucid']`, its counts (cells, genes, fields by kind, whether the
   * default graph is there) and the data-mapping probes (`probeMapping`).
   *
   * @this {import('../reader.js').AnnDataReader}
   * @returns {Promise<{title: string|null, cellucid: Object|null, stats: Object, probes: Object,
   *   obs_fields: Array<{key: string, kind: string}>}>}
   */
  async getDatasetMetadata() {
    this._ensureOpen();
    const generation = this._generation;
    // No matrix value is read for the first view (`probeMapping`).
    const probes = await this.probeMapping({ counts: false });
    let nCategorical = 0;
    let nContinuous = 0;
    for (const key of this._obsKeys) {
      const info = await this._fieldInfo(key, { withCategories: false });
      if (info.dtype === 'categorical') nCategorical++;
      else if (info.dtype === 'float' || info.dtype === 'int' || info.dtype === 'uint') nContinuous++;
    }
    // The graph a file opens with is the data mapping's default
    // (`defaultGraph`); any other is read only when it is chosen.
    const graph = defaultGraph(probes.obsp.map(item => item.key), { modality: this._defaultModality ?? null });
    const hasConnectivity = graph !== null && await this.hasConnectivities(graph);
    const title = await this._title;
    this._assertGeneration(generation, 'building dataset metadata');
    return {
      title,
      cellucid: this._cellucid,
      stats: {
        n_cells: this._nObs,
        n_genes: this.hasExpressionMatrix ? this._nVars : 0,
        n_obs_fields: this._obsKeys.length,
        n_categorical_fields: nCategorical,
        n_continuous_fields: nContinuous,
        has_connectivity: hasConnectivity,
      },
      probes,
      obs_fields: this._obsKeys.map(key => ({ key, kind: 'unknown' })),
    };
  }
}
