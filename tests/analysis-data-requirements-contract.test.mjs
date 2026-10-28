/**
 * An analysis mode built on gene expression has no form to offer while no
 * genes are published: after choosing None, or on a dataset exported without
 * them. Its requirements say so, and the one requirement validator every form
 * renders through refuses before any form control reads the dataset, so no
 * control fails on a dataset without genes as a page error.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CorrelationAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/correlation-analysis-ui.js';
import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';
import { DetailedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/detailed-analysis-ui.js';
import { GeneSignatureUI } from '../assets/js/app/analysis/ui/analysis-types/gene-signature-ui.js';
import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';
import { QuickInsights } from '../assets/js/app/analysis/ui/analysis-types/quick-insights-ui.js';

const GENE_MODES = Object.freeze([DEAnalysisUI, GeneSignatureUI, GenesPanelUI]);
const OTHER_MODES = Object.freeze([
  CorrelationAnalysisUI,
  DetailedAnalysisUI,
  QuickInsights,
]);

/**
 * One analysis UI over a data layer that publishes exactly `genes`. The
 * validators read only the data layer and the subclass's requirements.
 */
function uiOver(UiClass, genes, listing = { pending: false, failure: null }) {
  const ui = Object.create(UiClass.prototype);
  ui.dataLayer = {
    // The gene list of a dataset just shown is read after its first view.
    state: {
      areGenesPending: () => listing.pending,
      getGeneListFailure: () => listing.failure,
    },
    getAvailableVariables(type) {
      assert.equal(type, 'gene_expression');
      return genes;
    },
  };
  return ui;
}

test('modes built on gene expression declare it', () => {
  for (const UiClass of GENE_MODES) {
    assert.equal(UiClass.getRequirements().geneExpression, true, UiClass.name);
  }
  for (const UiClass of OTHER_MODES) {
    assert.notEqual(
      UiClass.getRequirements()?.geneExpression,
      true,
      UiClass.name,
    );
  }
});

test('without genes a gene-expression mode refuses before its pages', () => {
  for (const UiClass of GENE_MODES) {
    const ui = uiOver(UiClass, []);
    const refusal = { valid: false, error: 'Requires gene expression data.' };
    assert.deepEqual(ui.validateDataRequirements(), refusal, UiClass.name);
    assert.deepEqual(ui.validateRequirements([]), refusal, UiClass.name);
  }
});

test('while the gene names are read after the first view, a gene-expression mode waits for them', () => {
  for (const UiClass of GENE_MODES) {
    const pending = uiOver(UiClass, [], { pending: true, failure: null });
    assert.deepEqual(pending.validateDataRequirements(), {
      valid: false,
      pending: true,
      error: 'Reading the gene names… This analysis opens once they are read.',
    }, UiClass.name);
    const failed = uiOver(UiClass, [], { pending: false, failure: new Error('the var index could not be read') });
    assert.deepEqual(failed.validateDataRequirements(), {
      valid: false,
      error: 'The gene names could not be read: the var index could not be read',
    }, UiClass.name);
  }
});

test('with genes a gene-expression mode validates its pages as before', () => {
  for (const UiClass of GENE_MODES) {
    const ui = uiOver(UiClass, ['GENE_A']);
    assert.deepEqual(ui.validateDataRequirements(), { valid: true });
    assert.deepEqual(ui.validateRequirements([]), { valid: true });
  }
});

test('modes not built on gene expression never ask for genes', () => {
  for (const UiClass of OTHER_MODES) {
    const ui = Object.create(UiClass.prototype);
    ui.dataLayer = {
      getAvailableVariables() {
        throw new Error(`${UiClass.name} must not read the gene inventory.`);
      },
    };
    assert.deepEqual(ui.validateDataRequirements(), { valid: true });
  }
});
