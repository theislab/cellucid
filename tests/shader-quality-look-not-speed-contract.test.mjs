/**
 * Shader quality is a look choice, not a speed control, and the application
 * has to say so.
 *
 * `Full`, `Light` and `Ultra-light` are within noise at every point size, and
 * so is every individual term inside them — fog, lighting, the alpha texture
 * fetch and the round discard (measured: 28_decisions_rendering_layers.md).
 * The reason is structural rather than a property of one GPU: depth writes are
 * on and submission order is uncorrelated with depth, so roughly 95% of
 * rasterized fragments are killed before the fragment shader runs. Only about
 * 5% of the fill is ever shaded, and making that 5% cheaper is not visible.
 *
 * Two surfaces could claim the opposite and both are pinned here.
 *
 *   - The `Shader quality:` tooltip in the sidebar must not tell users that
 *     lowering it "reduces GPU work for smoother interaction". That is the
 *     single sentence most likely to drift back, because it is the intuitive
 *     thing to write.
 *   - The bottleneck analyser must not compute a `Shader Complexity` figure
 *     from a `full` minus `ultralight` delta and print it as `Shader overhead:`.
 *
 * One regime is the exception, and the tooltip says so rather than hiding it.
 * A 1-D or 2-D view is drawn without depth, so nothing is killed before the
 * fragment shader: every overlapping fragment is shaded and blended, and with
 * antialiasing on a dense embedding is bound by that blending. There `Light`
 * draws without a discard (HP_FS_LIGHT_NO_DEPTH) and `Light`/`Ultra-light`
 * take about half the frame time of `Full` there (measured:
 * 28_decisions_rendering_layers.md). Any frame-time difference the tooltip
 * states must be scoped to 2-D views and name the machine it was measured on;
 * the claim "shader quality is a speed control" stays out.
 *
 * That statistic cannot measure the effect it names, and no gate rescues it.
 * `_measureFrameTimes` records the wall-clock interval between
 * `requestAnimationFrame` callbacks: quantised to the display refresh whenever
 * the frame fits its budget, and mixing CPU, GPU, compositor and browser
 * scheduling into one number. A noise floor derived from that same instrument
 * inherits its unreliability — measuring one quality twice and using the twin
 * difference as a floor still passes a "separation" where the true effect is
 * zero (tried: 28_decisions_rendering_layers.md). There is no regime in which
 * a verdict from this instrument both fires and is trustworthy, so it emits
 * none.
 *
 * The measurement that does discriminate is point size. It is the real
 * control: vertex work is flat regardless of size, so the cost is per-sprite
 * rasterization and shrinking points genuinely helps once fill begins to
 * matter. The harness sweeps point size, so the panel reports that response in
 * place of a noise delta.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { BottleneckAnalyzer } from '../assets/js/dev/benchmark.js';
import { infoTipText } from './helpers/info-tip-text.mjs';

const INDEX_URL = new URL('../index.html', import.meta.url);
const BENCHMARK_URL = new URL('../assets/js/dev/benchmark.js', import.meta.url);

const [indexHtml, benchmarkSource] = await Promise.all([
  readFile(INDEX_URL, 'utf8'),
  readFile(BENCHMARK_URL, 'utf8'),
]);

function makeAnalyzer() {
  // `_initGPUTimer` returns early without a context, so the analysis helpers
  // below run against their arguments alone.
  return new BottleneckAnalyzer(null, {});
}

function boundAnalysis(boundType = 'balanced') {
  return {
    boundType,
    pointSizeScaling: {
      scalingFactor: 1.82,
      timeRatio: 1.82,
      sizeRatio: 16,
      smallestPointSize: 1,
      largestPointSize: 16,
      baselineMs: 12.0,
      largestMs: 21.8,
      interpretation: 'balanced',
    },
    lodScaling: { scalingFactor: 1.2, timeRatio: 1.2, pointRatio: 3, fewestPoints: 1000, mostPoints: 3000 },
    analysis: {
      fragmentBoundScore: 1.82,
      vertexBoundScore: 1.2,
      explanation: 'balanced',
    },
  };
}

function cpuPhases() {
  return {
    lodOverhead: { overhead: 0.2 },
    frustumCullingOverhead: { overhead: 0.1 },
  };
}

// ---------------------------------------------------------------------------
// The analysis does not measure, name, or act on shader quality
// ---------------------------------------------------------------------------

test('the CPU phase sweep never changes the quality the user is looking at', () => {
  const body = methodBody(benchmarkSource, 'async _runCPUPhaseAnalysis(config)');
  assert.doesNotMatch(
    body,
    /setQuality\(/,
    'the analysis must not switch shader quality to time it'
  );
  assert.doesNotMatch(
    body,
    /shaderComplexity|shaderQuality|shaderTests/,
    'the analysis must not produce a shader-quality phase result'
  );
  // The original quality is still read, because the stable render parameters
  // are pinned to it for the LOD and frustum arms.
  assert.match(body, /renderParams\.quality = originalQuality/);
});

test('no bottleneck verdict names shader complexity, at any input', () => {
  const analyzer = makeAnalyzer();
  for (const bound of ['balanced', 'fragment', 'vertex']) {
    const verdict = analyzer._determineBottleneckType(
      { fps: 24, avgFrameTime: 41 },
      cpuPhases(),
      { available: true, boundBy: 'GPU', avgGpuTimeMs: 40, avgCpuTimeMs: 12 },
      boundAnalysis(bound),
      { hasJank: true, severity: 'severe', jankPercent: 100 },
      { health: 'poor', gcPressure: 'high', mainThreadBlocked: true }
    );
    const named = verdict.all.map(entry => entry.type);
    assert.ok(
      !named.includes('Shader Complexity'),
      `bound=${bound} named a shader bottleneck: ${JSON.stringify(named)}`
    );
  }
});

const SHADER_SPEED_ADVICE =
  /ultra-?light|shader quality|shader complexity|disable fog|bak(?:e|ing) lighting|removes expensive lighting/i;

test('no recommendation proposes a shader quality change for performance', () => {
  const analyzer = makeAnalyzer();
  const baseline = { fps: 18, avgFrameTime: 55 };

  // Every branch that could reach for `ultralight`: GPU bound, fragment
  // bound, and a low-core device.
  const cases = [
    {
      gpu: { available: true, boundBy: 'GPU', gpuUtilization: 96 },
      bound: boundAnalysis('balanced'),
      js: {},
    },
    {
      gpu: { available: true, boundBy: 'GPU', gpuUtilization: 96 },
      bound: boundAnalysis('fragment'),
      js: {},
    },
    {
      gpu: { available: false },
      bound: boundAnalysis('vertex'),
      js: { cpuCores: 2 },
    },
  ];

  for (const { gpu, bound, js } of cases) {
    const { recommendations } = analyzer._generateRecommendations(
      baseline,
      cpuPhases(),
      gpu,
      bound,
      { memoryPressure: { level: 'low' }, totalEstimatedMB: 120 },
      { hasJank: true, severity: 'severe', jankPercent: 100 },
      js
    );

    assert.ok(recommendations.length > 0, 'a slow frame must still advise');
    for (const recommendation of recommendations) {
      assert.doesNotMatch(
        recommendation.title,
        SHADER_SPEED_ADVICE,
        `recommendation title proposes a shader change: ${recommendation.title}`
      );
      for (const action of recommendation.actions) {
        assert.doesNotMatch(
          String(action),
          SHADER_SPEED_ADVICE,
          `recommendation action proposes a shader change: ${action}`
        );
      }
    }
  }
});

test('no bound-type explanation proposes a simpler shader', () => {
  // This prose reaches the user through `boundAnalysis.analysis.explanation`
  // and is not produced by `_generateRecommendations`, so the behavioral sweep
  // above cannot see it.
  const analyzer = makeAnalyzer();
  for (const bound of ['fragment', 'vertex', 'balanced']) {
    const explanation = analyzer._explainBoundType(bound, 2.4, 1.1);
    assert.doesNotMatch(
      explanation,
      /simpler shader|shader quality|ultra-?light|disable fog/i,
      `the ${bound} explanation still proposes a shader change: ${explanation}`
    );
  }
});

// ---------------------------------------------------------------------------
// The summary reports the control that responds, and no shader overhead
// ---------------------------------------------------------------------------

test('the summary drops the shader overhead figure for the point-size response', () => {
  const analyzer = makeAnalyzer();
  const summary = analyzer._generateSummary(
    {
      fps: 24,
      avgFrameTime: 41,
      p95FrameTime: 52,
      p99FrameTime: 60,
      stdDev: 4,
      rendererStats: { avgVisiblePoints: 1e7, avgLodLevel: 0, avgDrawCalls: 1 },
    },
    cpuPhases(),
    { available: false },
    boundAnalysis(),
    { totalEstimatedMB: 120, gpuMemoryEstimated: false },
    {},
    {}
  );

  assert.ok(
    !('shaderComplexityMs' in summary.overhead),
    'the summary must not carry a shader overhead figure'
  );
  assert.equal(summary.bottleneck.pointSizeResponse, '1.82× over 1→16px');
});

test('a sweep too short to compare is refused, not scored as 1', () => {
  const analyzer = makeAnalyzer();
  assert.throws(
    () => analyzer._calculateScaling({ 4: { avg: 12 } }),
    /point size/i
  );
  assert.throws(
    () => analyzer._calculateLODScaling({ 0: { avg: 12, visiblePoints: 10 } }),
    /LOD/i
  );
});

// ---------------------------------------------------------------------------
// The panel and the tooltip
// ---------------------------------------------------------------------------

function methodBody(source, declaration) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must exist in benchmark.js`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${declaration} is unbalanced`);
}

// The tip text lives in the registry the markup names it from.
const tooltipContent = id => infoTipText(indexHtml, id);

test('the shader-quality tooltip calls it a look, never a speed control', () => {
  const content = tooltipContent('shader-quality-info-tooltip');

  assert.doesNotMatch(
    content,
    /reduces? gpu work|smoother interaction|faster|speed up|better performance|improves? performance/i,
    'the tooltip must not claim a speed benefit measurement has refuted'
  );
  // The one measured difference is scoped to where it exists.
  if (/half the frame time|frame time/i.test(content)) {
    assert.match(content, /2D views/, 'a stated frame-time difference must be scoped to 2D views');
    assert.match(content, /3D views/, 'and must say 3D views measured the same');
  }
  assert.match(
    content,
    /look|appearance/i,
    'the tooltip must say the setting changes what is drawn'
  );
  assert.match(
    content,
    /point size/i,
    'the tooltip must point at the control that does respond'
  );
  // Absolute numbers belong to one machine and must say so.
  if (/\d+(?:\.\d+)?\s*(?:ms|%|fps)/i.test(content)) {
    assert.match(
      content,
      /M1 Pro|Apple/i,
      'a quoted absolute figure must name the machine it was measured on'
    );
  }
});

test('a tooltip quoting an absolute figure names the machine it came from', () => {
  // These are one GPU's numbers. A reader who takes them as a general property
  // of the app will plan around a speed-up that may not exist on their machine.
  for (const id of ['shader-quality-info-tooltip', 'antialias-info-tooltip']) {
    const content = tooltipContent(id);
    if (!/\d+(?:\.\d+)?\s*(?:ms|%|fps)/i.test(content)) continue;
    assert.match(
      content,
      /M1 Pro|Apple/i,
      `${id} quotes an absolute figure without naming the machine`
    );
  }
});
