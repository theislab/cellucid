/**
 * A ratio of means of log-scale values is no "X-fold" change (F159: two live
 * passes saw an agent call one "16-fold"). The analyses that report a fold
 * change "of the means as stored" say what that is on log-scale values, in
 * the `about` an agent reads with the result; the agent instructions say it
 * once (`tests/agent-bridge.test.mjs`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SAID = 'of the means as stored (log2 of their ratio; of log-scale values, such as log1p, a ratio of means is no fold change of expression)';

test('every analysis result that reports a fold change of the means as stored says it is no fold change on log-scale values', () => {
  for (const file of ['assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js', 'assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js']) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(text.includes(SAID), file);
    assert.equal(/'of the means as stored'/.test(text), false, `${file}: no bare "of the means as stored"`);
  }
});
