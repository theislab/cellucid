import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BenchmarkReporter,
  BottleneckAnalyzer,
} from '../assets/js/dev/benchmark.js';

const MEBIBYTE = 1024 * 1024;

function createAnalyzer(gpuMemoryMB, pointCount = 20) {
  const gl = {
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_VERTEX_ATTRIBS: 0x8869,
    MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
    getParameter(parameter) {
      if (parameter === this.MAX_TEXTURE_SIZE) return 8192;
      if (parameter === this.MAX_VERTEX_ATTRIBS) return 16;
      if (parameter === this.MAX_VERTEX_UNIFORM_VECTORS) return 1024;
      throw new Error(`unexpected WebGL parameter ${parameter}`);
    },
  };
  return Object.assign(
    Object.create(BottleneckAnalyzer.prototype),
    {
      gl,
      renderer: {
        _positions: new Float32Array(pointCount * 3),
        getStats(viewId) {
          assert.equal(viewId, 'benchmark');
          return { gpuMemoryMB };
        },
      },
    },
  );
}

test('bottleneck memory analysis uses finite nonnegative renderer-owned bytes', () => {
  const exactGpuMemoryMB = 777.25;
  const analysis =
    createAnalyzer(exactGpuMemoryMB)._analyzeMemory();

  assert.equal(analysis.reportedGpuMemoryMB, exactGpuMemoryMB);
  assert.equal(analysis.totalEstimatedMB, exactGpuMemoryMB);
  assert.equal(analysis.gpuMemoryEstimated, false);
  assert.equal(analysis.memoryPressure.gpuMB, exactGpuMemoryMB);
  assert.equal(
    analysis.breakdownEstimated,
    true,
    'component heuristics must not masquerade as an exact breakdown',
  );
});

for (const invalidMemory of [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  -1,
  '12',
]) {
  test(`bottleneck memory analysis labels ${String(invalidMemory)} fallback as an estimate`, () => {
    const pointCount = 20;
    const analysis =
      createAnalyzer(invalidMemory, pointCount)._analyzeMemory();
    const expectedEstimateMB =
      pointCount * (16 + 24 + 1 + 4) / MEBIBYTE;

    assert.equal(analysis.reportedGpuMemoryMB, null);
    assert.equal(analysis.totalEstimatedMB, expectedEstimateMB);
    assert.equal(analysis.gpuMemoryEstimated, true);
    assert.equal(
      analysis.memoryPressure.gpuMB,
      expectedEstimateMB,
    );
  });
}

test('situation reporter distinguishes exact renderer memory from its pre-publication estimate', () => {
  const reporter = new BenchmarkReporter();
  const exact = reporter._collectRendererSnapshot(null, {
    dataset: { pointCount: 100 },
    rendererStats: { gpuMemoryMB: 321.5 },
  });
  assert.equal(exact.gpuMemoryMB, 321.5);
  assert.equal(exact.gpuMemoryEstimated, false);

  const estimated = reporter._collectRendererSnapshot(null, {
    dataset: { pointCount: 100 },
    rendererStats: { gpuMemoryMB: Number.NaN },
  });
  assert.equal(
    estimated.gpuMemoryMB,
    100 * 28 / MEBIBYTE,
  );
  assert.equal(estimated.gpuMemoryEstimated, true);

  const unavailable = reporter._collectRendererSnapshot(null, {
    rendererStats: null,
  });
  assert.equal(unavailable.gpuMemoryMB, null);
  assert.equal(unavailable.gpuMemoryEstimated, false);
});

test('situation-report memory findings identify exact and estimated values truthfully', () => {
  const reporter = new BenchmarkReporter();
  const environment = {};
  const dataset = { pointCount: 0 };
  const thresholds = {
    ...BenchmarkReporter.DEFAULT_THRESHOLDS,
    memory: {
      critical: 1000,
      warning: 700,
      high: 500,
    },
  };

  const exactIssues = reporter._detectIssues(
    environment,
    {
      frameTime: null,
      gpuMemoryEstimated: false,
      gpuMemoryMB: 800,
      rendererConfig: {},
    },
    dataset,
    null,
    thresholds,
  );
  const exactMemoryIssue = exactIssues.find(
    issue => issue.category === 'memory',
  );
  assert.match(exactMemoryIssue.message, /Managed GPU memory 800MB/);
  assert.equal(exactMemoryIssue.details.estimated, false);

  const estimatedIssues = reporter._detectIssues(
    environment,
    {
      frameTime: null,
      gpuMemoryEstimated: true,
      gpuMemoryMB: 800,
      rendererConfig: {},
    },
    dataset,
    null,
    thresholds,
  );
  const estimatedMemoryIssue = estimatedIssues.find(
    issue => issue.category === 'memory',
  );
  assert.match(
    estimatedMemoryIssue.message,
    /Estimated GPU memory ~800MB/,
  );
  assert.equal(estimatedMemoryIssue.details.estimated, true);
});

test('main benchmark panel consumes exact renderer memory and labels only the pre-render fallback as an estimate', async () => {
  const mainSource = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8',
  );
  const helperStart = mainSource.indexOf(
    'function formatBenchmarkGpuMemory',
  );
  const helperEnd = mainSource.indexOf(
    '// Default export base URL',
    helperStart,
  );
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helperSource =
    mainSource.slice(helperStart, helperEnd);
  assert.match(
    helperSource,
    /Number\.isFinite\(exactGpuMemoryMB\)/,
  );
  assert.match(helperSource, /exactGpuMemoryMB >= 0/);
  assert.match(helperSource, /\(estimate\)/);

  const renderStart = mainSource.indexOf(
    'const renderBenchmarkStats =',
  );
  const renderEnd = mainSource.indexOf(
    'const startPerfMonitoring =',
    renderStart,
  );
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const renderSource = mainSource.slice(renderStart, renderEnd);
  assert.match(
    renderSource,
    /formatBenchmarkGpuMemory\(hpStats, pointCount\)/,
  );
  assert.doesNotMatch(
    renderSource,
    /pointCount[\s\S]{0,80}\*\s*28/,
  );
  assert.match(mainSource, /estimated GPU memory/);
  assert.match(
    mainSource,
    /s\.rendering\.gpuMemoryEstimated/,
  );
});
