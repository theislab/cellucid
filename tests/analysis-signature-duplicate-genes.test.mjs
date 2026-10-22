import assert from 'node:assert/strict';
import test from 'node:test';

import { GeneSignatureUI } from '../assets/js/app/analysis/ui/analysis-types/gene-signature-ui.js';

const validValues = Object.freeze({
  method: 'mean',
  normalize: 'none',
  plotType: 'violinplot',
});

test('a gene listed twice is a form error naming the gene, not a scoring failure', () => {
  const ui = Object.create(GeneSignatureUI.prototype);
  const validation = ui._validateForm({ ...validValues, genes: ['CD3E', 'CD8A', 'CD3E'] });
  assert.equal(validation.valid, false);
  assert.match(validation.error, /CD3E.*more than once/);
  assert.deepEqual(
    ui._validateForm({ ...validValues, genes: ['CD3E', 'CD8A'] }),
    { valid: true },
  );
});

test('the automatic signature run validates the form before scoring', async () => {
  const shown = [];
  let scored = 0;
  const ui = Object.create(GeneSignatureUI.prototype);
  Object.assign(ui, {
    _isDestroyed: false,
    _canRunAnalysis: () => true,
    _startAnalysisRequest: () => 7,
    _claimBusy: () => () => {},
    _getFormValues: () => ({ ...validValues, genes: ['CD3E', 'CD3E'] }),
    _runAnalysisImpl: async () => {
      scored++;
      return null;
    },
    _isCurrentAnalysisRequest: () => true,
    _showError: async (message) => {
      shown.push(message);
    },
    _finishAnalysisRequest: () => {},
  });
  await ui._runAnalysisIfValid();
  assert.equal(scored, 0);
  assert.equal(shown.length, 1);
  assert.match(shown[0], /CD3E.*more than once/);
});
