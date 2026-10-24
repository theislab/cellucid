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
function uiOver(UiClass, genes) {
  const ui = Object.create(UiClass.prototype);
  ui.dataLayer = {
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
