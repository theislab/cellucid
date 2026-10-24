import assert from 'node:assert/strict';
import test from 'node:test';

import { computeDifferential } from '../assets/js/app/analysis/compute/operation-handlers.js';

const ramp = (start, length = 20, step = 0.01) =>
  Float32Array.from({ length }, (_, index) => start + index * step);

function meanOf(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

test('DE fold change keeps the published formula for non-negative expression', () => {
  const groupAValues = ramp(2);
  const groupBValues = ramp(0.5);
  const result = computeDifferential({ groupAValues, groupBValues, method: 'wilcox' });
  const expected = Math.log2((result.meanA + 0.01) / (result.meanB + 0.01));
  assert.equal(result.log2FoldChange, expected);
});

for (const [label, startA, startB] of [
  ['both means negative', -1.5, -0.5],
  ['means of opposite sign', -0.5, 0.5],
  ['both means negative, A higher', -0.2, -1.4],
]) {
  test(`DE fold change on scaled data is finite with the sign of meanA - meanB (${label})`, () => {
    const groupAValues = ramp(startA);
    const groupBValues = ramp(startB);
    for (const method of ['wilcox', 'ttest']) {
      const result = computeDifferential({ groupAValues, groupBValues, method });
      assert.ok(Number.isFinite(result.log2FoldChange), String(result.log2FoldChange));
      assert.equal(
        Math.sign(result.log2FoldChange),
        Math.sign(meanOf(groupAValues) - meanOf(groupBValues)),
      );
      // Shifting by the minimum of the compared cells makes it a fold change
      // of non-negative means.
      let minimum = Infinity;
      for (const value of [...groupAValues, ...groupBValues]) {
        minimum = Math.min(minimum, value);
      }
      const shift = Math.min(0, minimum);
      assert.ok(
        Math.abs(
          result.log2FoldChange -
          Math.log2((result.meanA - shift + 0.01) / (result.meanB - shift + 0.01))
        ) < 1e-12,
      );
    }
  });
}

test('marker worker fold change on scaled data matches DE and keeps its sign', async () => {
  const messages = [];
  globalThis.self = { postMessage: message => messages.push(message) };
  try {
    await import('../assets/js/app/analysis/compute/data-worker.js?scaled-fold-change');
    const runWorker = (type, payload, requestId) => {
      globalThis.self.onmessage({ data: { type, payload, requestId } });
      const message = messages.at(-1);
      assert.equal(message.requestId, requestId);
      assert.equal(message.success, true, message.error);
      return message.result;
    };

    const groupA = ramp(-2, 10, 0.02);
    const groupB = ramp(-0.5, 10, 0.02);
    const groupC = ramp(0.3, 10, 0.02);
    const values = Float32Array.from([...groupA, ...groupB, ...groupC]);
    runWorker('MARKERS_SET_CONTEXT', {
      codes: Uint16Array.from(values, (_, index) => Math.floor(index / 10)),
      codeToGroupIndex: Int32Array.from([0, 1, 2]),
      groupCount: 3,
      tested: Uint8Array.of(1, 1, 1),
      reference: -1,
    }, 'scaled-context');
    const result = runWorker('MARKERS_COMPUTE_GENE', {
      values,
      method: 'wilcox',
      minCells: 2,
      pConvention: 'exact',
      foldChange: { mode: 'stored' },
    }, 'scaled-gene');

    const groups = [groupA, groupB, groupC];
    for (let group = 0; group < 3; group++) {
      const rest = groups.filter((_, index) => index !== group).flatMap(g => [...g]);
      const reference = computeDifferential({
        groupAValues: groups[group],
        groupBValues: Float32Array.from(rest),
        method: 'wilcox',
      });
      const foldChange = result.log2FoldChange[group];
      assert.ok(Number.isFinite(foldChange), `group ${group}: ${foldChange}`);
      assert.equal(Math.sign(foldChange), Math.sign(reference.meanA - reference.meanB));
      assert.ok(
        Math.abs(foldChange - reference.log2FoldChange) < 1e-5,
        `group ${group}: ${foldChange} vs ${reference.log2FoldChange}`,
      );
    }
  } finally {
    delete globalThis.self;
  }
});
