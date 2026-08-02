/**
 * @fileoverview The two UI refresh paths must not drift apart silently.
 *
 * `ui-coordinator.js` carries two hand-maintained lists of "refresh the
 * surfaces that describe the current view": `refreshUiAfterStateLoad`, which
 * runs after a session or dataset load, and `refreshUIForActiveView`, which
 * runs when the active view changes. They share most of their contents.
 *
 * The file's own comment above `handleActiveFieldChanged` records what happens
 * when they drift: "A second, partial copy of this list is how the sidebar came
 * to disagree with itself" - a state-driven activation refreshed the legend and
 * the selectors but not the rest, and a switch to a kept view refreshed a
 * third, shorter set.
 *
 * Merging them would change the order of calls inside a refresh path, which is
 * the kind of change that reintroduces exactly that class of defect. So the
 * relationship is pinned instead: the differences between the two lists are
 * enumerated here, with a reason for each, and adding a surface to one without
 * the other fails.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const COORDINATOR_URL = new URL(
  '../assets/js/app/ui/core/ui-coordinator.js',
  import.meta.url
);

/**
 * Every call of the form `owner.method?.()` or `owner.method()` in one body,
 * plus bare calls, normalised to a comparable name.
 */
function callsIn(body, shared = null) {
  // One caller delegates to the extracted sequence rather than repeating it,
  // so the comparison has to follow that call. Before the extraction the two
  // view-refresh paths were seven identical lines differing by one; they now
  // share by construction, and what remains to check is the state-load path.
  if (shared !== null && /refreshViewDependentSurfaces\(/.test(body)) {
    body = `${body}\n${shared}`;
  }
  const calls = new Set();
  for (const [, name] of body.matchAll(/([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+)(?:\?\.)?\(/g)) {
    calls.add(name.replace(/\?\./g, '.'));
  }
  // Bare calls are indented differently in the two bodies - one is a function
  // declaration, the other an arrow inside an object literal - so indentation
  // cannot be part of the pattern without inventing a difference that is not
  // there.
  const KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
    // The delegation itself is not a surface; its contents were inlined above.
    'refreshViewDependentSurfaces'
  ]);
  for (const [, name] of body.matchAll(/^\s+([A-Za-z_$][\w$]*)\(/gm)) {
    if (!KEYWORDS.has(name)) calls.add(name);
  }
  return calls;
}

function bodyOf(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `could not find ${header} in ui-coordinator.js`);
  let depth = 0;
  let index = source.indexOf('{', start);
  const open = index;
  for (; index < source.length; index++) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  assert.fail(`unbalanced braces after ${header}`);
}

// Each difference is deliberate and says why. A new entry here is a decision;
// an unexplained one is what this test exists to stop.
const ONLY_AFTER_A_STATE_LOAD = new Map([
  ['fieldSelector.renderFieldSelects', 'the set of fields itself can differ after a load'],
  ['fieldSelector.renderDeletedFieldsSection', 'soft-deleted fields arrive with the session'],
  ['fieldSelector.initGeneExpressionDropdown', 'the gene inventory belongs to the dataset'],
  ['highlightControls.renderHighlightPages', 'pages are restored, not merely re-read']
]);
const ONLY_WHEN_THE_VIEW_CHANGES = new Map([
  ['renderControls.markSmokeDirty', 'a different view needs its volume re-rendered']
]);

test('the two refresh paths differ only where they are documented to', async () => {
  const source = await readFile(COORDINATOR_URL, 'utf8');
  const shared = bodyOf(source, 'function refreshViewDependentSurfaces(viewId)');
  const afterLoad = callsIn(bodyOf(source, 'function refreshUiAfterStateLoad()'), shared);
  const onViewChange = callsIn(bodyOf(source, 'refreshUIForActiveView: () =>'), shared);

  assert.ok(afterLoad.size >= 8, `parsed ${afterLoad.size} calls after a load`);
  assert.ok(onViewChange.size >= 6, `parsed ${onViewChange.size} calls on view change`);

  const missingOnViewChange = [...afterLoad]
    .filter(call => !onViewChange.has(call))
    .filter(call => !ONLY_AFTER_A_STATE_LOAD.has(call))
    .sort();
  assert.deepEqual(
    missingOnViewChange,
    [],
    'these refresh after a state load but not when the view changes. Either '
      + 'add them to refreshUIForActiveView, or record here why the view '
      + 'change does not need them'
  );

  const missingAfterLoad = [...onViewChange]
    .filter(call => !afterLoad.has(call))
    .filter(call => !ONLY_WHEN_THE_VIEW_CHANGES.has(call))
    .sort();
  assert.deepEqual(
    missingAfterLoad,
    [],
    'these refresh when the view changes but not after a state load. A state '
      + 'load changes the view too, so this is the shape that let the sidebar '
      + 'disagree with itself'
  );
});

test('every documented difference is still real', async () => {
  const source = await readFile(COORDINATOR_URL, 'utf8');
  const shared = bodyOf(source, 'function refreshViewDependentSurfaces(viewId)');
  const afterLoad = callsIn(bodyOf(source, 'function refreshUiAfterStateLoad()'), shared);
  const onViewChange = callsIn(bodyOf(source, 'refreshUIForActiveView: () =>'), shared);

  for (const [call, reason] of ONLY_AFTER_A_STATE_LOAD) {
    assert.ok(
      afterLoad.has(call) && !onViewChange.has(call),
      `"${call}" is recorded as load-only (${reason}) but the code no longer `
        + 'matches; remove the entry rather than leaving it to mislead'
    );
  }
  for (const [call, reason] of ONLY_WHEN_THE_VIEW_CHANGES) {
    assert.ok(
      onViewChange.has(call) && !afterLoad.has(call),
      `"${call}" is recorded as view-change-only (${reason}) but the code no `
        + 'longer matches; remove the entry rather than leaving it to mislead'
    );
  }
});
