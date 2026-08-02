// One publication of "the active field changed".
//
// The sidebar names the active field in the statistics line, draws it in the
// legend, and offers its outlier control. Those three came from two lists: the
// complete one the field selector calls back into, and partial copies used when
// the change arrived from state instead of from a click. The copies drifted —
// a dataset's advertised starting state, Load State and a Jupyter command all
// coloured the plot and populated the legend while the statistics line kept
// reading "Field: None". These assertions keep the partial copies from coming
// back.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const coordinatorSource = await readFile(
  new URL('../assets/js/app/ui/core/ui-coordinator.js', import.meta.url),
  'utf8'
);

/**
 * @param {string} signature Exact first line of the function.
 * @param {string} terminator Exact first line after the function body.
 * @returns {string}
 */
function readFunctionBody(signature, terminator) {
  const start = coordinatorSource.indexOf(signature);
  assert.ok(start >= 0, `ui-coordinator must define ${signature.trim()}`);
  const end = coordinatorSource.indexOf(terminator, start + signature.length);
  assert.ok(end > start, `${signature.trim()} must be a closed body`);
  return coordinatorSource.slice(start, end);
}

test('the active-field publication names the field everywhere it is shown', () => {
  const body = readFunctionBody(
    '  function handleActiveFieldChanged(fieldInfo) {',
    '\n  }\n'
  );
  for (const surface of [
    /legend\.render\?\.\(info\.field\)/,
    /legend\.handleOutlierUI\?\.\(info\.field\)/,
    /highlightControls\.updateHighlightMode\?\.\(\)/,
    /communityAnnotationControls\.render\?\.\(\)/
  ]) {
    assert.match(body, surface);
  }
  // Called with nothing, it must rebuild the field info from current state so
  // a state-driven refresh reports the same thing a click does.
  assert.match(body, /const info = fieldInfo \|\| buildStatsInfoFromState\(\)/);
});

test('every active-field refresh path uses that one publication', () => {
  const paths = [
    ['refreshUiAfterStateLoad', '  function refreshUiAfterStateLoad() {', '\n  }\n'],
    ['handleFieldChanged', '  const handleFieldChanged = () => {', '\n  };\n'],
    // Each view carries its own active field — `setActiveView` restores
    // `ctx.activeFieldIndex` — so switching to a kept view is an active-field
    // change and needs the same publication, not a shorter copy of it.
    // Both view-refresh callers delegate to this one sequence rather than
    // repeating it. Checking it here checks both of them, and the delegation
    // itself is asserted separately below so neither can quietly stop using it.
    [
      'refreshViewDependentSurfaces',
      '  function refreshViewDependentSurfaces(viewId) {',
      '\n  }\n'
    ]
  ];
  for (const [label, signature, terminator] of paths) {
    const body = readFunctionBody(signature, terminator);
    assert.match(
      body,
      /handleActiveFieldChanged\(\)/,
      `${label} must publish the active field through the shared handler`
    );
    for (const partial of [
      /statsDisplay\./,
      /legend\.render/,
      /legend\.handleOutlierUI/,
      /highlightControls\.updateHighlightMode/,
      /communityAnnotationControls\.render/
    ]) {
      assert.doesNotMatch(
        body,
        partial,
        `${label} must not keep its own partial copy of that list`
      );
    }
  }
});

test('both view-refresh callers reach the publication through the shared sequence', () => {
  // They used to be seven identical lines differing by one, which is the shape
  // the comment above `handleActiveFieldChanged` records as having already made
  // the sidebar disagree with itself once.
  const source = coordinatorSource;
  assert.match(
    source,
    /onActiveViewChanged: \(viewId\) => refreshViewDependentSurfaces\(viewId\)/,
    'the view-controls callback must delegate, not carry its own copy'
  );
  assert.match(
    source,
    /refreshUIForActiveView: \(\) => \{[^}]*refreshViewDependentSurfaces\(/,
    'the outside caller must delegate, not carry its own copy'
  );
});

test('the statistics line follows a signal, not a list of refresh sites', () => {
  // `#stats` is `sr-only`: a sighted user reads the legend and never sees it,
  // so a stale line misinforms screen-reader users and nobody else notices.
  // It is therefore published from the signals it depends on rather than from
  // refresh lists. DataState announces no "the active field changed", but
  // `setActiveField`, `setActiveVarField` and `clearActiveField` all end in
  // `computeGlobalVisibility()` and `setActiveView` ends in
  // `_notifyVisibilityChange()`, so `visibility:changed` reaches every one of
  // them — the same signal `highlight-controls.js` follows for the renderer's
  // highlight mode. A dimension change is the other input, because it moves the
  // centroid count.
  const batched = readFunctionBody(
    '  function scheduleVisibilityUiUpdate() {',
    '\n  }\n'
  );
  assert.match(
    batched,
    /publishStatsLine\(\)/,
    'the visibility signal must republish the statistics line'
  );
  const dimension = readFunctionBody(
    '  const handleDimensionChanged = () => {',
    '\n  };\n'
  );
  assert.match(
    dimension,
    /publishStatsLine\(\)/,
    'a dimension change must republish the statistics line'
  );

  // One writer. Anything else naming `statsDisplay` is a second list that can
  // fall behind the first, which is exactly how the line came to read
  // "Field: None" over a fully coloured plot.
  const writers = [
    ...coordinatorSource.matchAll(/statsDisplay\.updateStats/g)
  ];
  assert.equal(
    writers.length,
    1,
    'the statistics line must have exactly one writer'
  );
  const publisher = readFunctionBody(
    '  function publishStatsLine() {',
    '\n  }\n'
  );
  assert.match(publisher, /statsDisplay\.updateStats\?\.\(/);
  assert.match(publisher, /buildStatsInfoFromState\(\)/);
});
