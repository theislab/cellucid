/**
 * The community annotation UI deliberately keeps two modal shells:
 * `community-annotation/modal-shell.js` (`showClusterModal`, used by the
 * identity profile editor and the GitHub connection flow) and
 * `community-annotation-voting-modal.js` (`showModal` / `showSecondaryModal`).
 *
 * They are not merged because their lifecycles genuinely differ — close
 * ordering, the nested-Escape protocol, the primary/secondary cascade, and the
 * `COMMUNITY_MODAL_LOCAL_CLOSE` handle. The reasoning lives in the
 * `@fileoverview` of `modal-shell.js`.
 *
 * The cost of that decision is drift: two focus traps can be fixed apart. This
 * test is what pays that cost down. It pins the accessibility contract both
 * shells owe, and — critically — pins their *focusable element enumeration* to
 * be identical, because a selector added to one tab order and not the other is
 * the exact failure duplication produces and the one nothing else would catch.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLUSTER_SHELL = fileURLToPath(new URL(
  '../assets/js/app/ui/modules/community-annotation/modal-shell.js',
  import.meta.url
));
const VOTING_SHELL = fileURLToPath(new URL(
  '../assets/js/app/ui/modules/community-annotation-voting-modal.js',
  import.meta.url
));

const CLUSTER_SOURCE = readFileSync(CLUSTER_SHELL, 'utf8');
const VOTING_SOURCE = readFileSync(VOTING_SHELL, 'utf8');

const SHELLS = [
  ['the cluster modal shell', CLUSTER_SOURCE],
  ['the voting modal shell', VOTING_SOURCE],
];

/** `assert.ok` over a regex, so a failure names the clause instead of dumping the file. */
function requireClause(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

/**
 * Pull the focusable-element selector list out of a shell. Both shells build
 * it as an array literal joined with a comma, so read the array rather than
 * matching a hard-coded copy of it — a hard-coded copy would agree with a
 * broken pair just as happily as with a correct one.
 */
function focusableSelectors(source, label) {
  const anchor = source.indexOf("'a[href]'");
  assert.notEqual(
    anchor,
    -1,
    `${label} must still enumerate its focusable elements`
  );
  const start = source.lastIndexOf('[', anchor);
  assert.notEqual(start, -1, `${label} selector list must be an array literal`);

  const selectors = [];
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === ']') break;
    if (character !== "'") {
      assert.ok(
        /[\s,]/.test(character),
        `${label} focusable selectors must be exact string literals`
      );
      index += 1;
      continue;
    }
    const close = source.indexOf("'", index + 1);
    assert.notEqual(close, -1, `${label} has an unterminated selector`);
    selectors.push(source.slice(index + 1, close));
    index = close + 1;
  }
  return selectors;
}

test('both community annotation modal shells enumerate the same focusable elements', () => {
  const cluster = focusableSelectors(CLUSTER_SOURCE, 'the cluster modal shell');
  const voting = focusableSelectors(VOTING_SOURCE, 'the voting modal shell');

  assert.ok(
    cluster.length >= 6,
    `expected a real selector list, saw ${JSON.stringify(cluster)}`
  );
  assert.deepEqual(
    voting,
    cluster,
    'the two shells trap focus independently; a selector present in one tab ' +
    'order and absent from the other makes the same control reachable in one ' +
    'shell and unreachable in the other'
  );
});

test('both community annotation modal shells announce themselves as modal dialogs', () => {
  for (const [label, source] of SHELLS) {
    requireClause(
      source,
      /role:\s*'dialog',\s*'aria-modal':\s*'true'/,
      `${label} must build its overlay as an aria-modal dialog`
    );
    requireClause(
      source,
      /setAttribute\('aria-labelledby',/,
      `${label} must name its dialog from the title it rendered`
    );
    requireClause(
      source,
      /closeBtn\.focus\(\)/,
      `${label} must move focus into the dialog when it opens`
    );
    requireClause(
      source,
      /e\.key === 'Escape'/,
      `${label} must close on Escape`
    );
  }
});

test('both community annotation modal shells wrap Tab in both directions', () => {
  for (const [label, source] of SHELLS) {
    requireClause(
      source,
      /if \(e\.key !== 'Tab'\) return;/,
      `${label} must own a Tab trap`
    );
    requireClause(
      source,
      /if \(e\.shiftKey\) \{[\s\S]{0,400}?active === first[\s\S]{0,400}?last\.focus\(\);/,
      `${label} must wrap Shift+Tab from the first control back to the last`
    );
    requireClause(
      source,
      /active === last\)[\s\S]{0,400}?first\.focus\(\);/,
      `${label} must wrap Tab from the last control back to the first`
    );
    requireClause(
      source,
      /if \(!focusables\.length\) \{\s*e\.preventDefault\(\);/,
      `${label} must hold focus even when the dialog has no focusable control`
    );
    requireClause(
      source,
      /addEventListener\('keydown', onKeyDown, true\)/,
      `${label} must trap keys in the capture phase so content cannot pre-empt it`
    );
  }
});

test('both community annotation modal shells restore focus when they close', () => {
  for (const [label, source] of SHELLS) {
    requireClause(
      source,
      /const prevFocus = returnFocusTo \?\? document\.activeElement;/,
      `${label} must capture the focus it will hand back`
    );
    requireClause(
      source,
      /previousFocusAvailable[\s\S]{0,600}?returnFocusResolver\?\.\(\)/,
      `${label} must fall back to a resolver when the captured target is gone`
    );
    requireClause(
      source,
      /\[\s*'previous focus target',/,
      `${label} must restore focus as an accounted-for teardown step`
    );
  }
});

test('the voting shell keeps the rerender focus behaviour the cluster shell has no need for', () => {
  requireClause(
    VOTING_SOURCE,
    /function captureModalRerenderFocus\(root\)/,
    'the voting shell must still capture focus identity before a rebuild'
  );
  requireClause(
    VOTING_SOURCE,
    /function restoreModalRerenderFocus\(snapshot, root, closeTarget\)/,
    'the voting shell must still restore focus after a rebuild'
  );

  // Every rebuild must be bracketed, not just one of them: this is the exact
  // behaviour a shell merge would drop, and a single surviving bracketed site
  // must not be allowed to vouch for the others.
  const lines = VOTING_SOURCE.split('\n');
  const captures = [];
  const restores = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/captureModalRerenderFocus\(content\)/.test(line)) captures.push(index);
    if (/^\s*restoreModalRerenderFocus\($/.test(line) ||
        /^\s*restoreModalRerenderFocus\(\S/.test(line)) {
      restores.push(index);
    }
  }
  assert.ok(
    captures.length >= 3,
    `expected every voting content rebuild to capture focus, saw ${captures.length}`
  );
  assert.equal(
    restores.length,
    captures.length,
    'each captured rerender focus snapshot must be restored exactly once'
  );

  const unbracketed = [];
  for (const start of captures) {
    const window = lines.slice(start, start + 14).join('\n');
    if (!/content\.innerHTML = '';/.test(window)) {
      unbracketed.push(`line ${start + 1} captures focus but rebuilds nothing`);
      continue;
    }
    if (!/restoreModalRerenderFocus\(/.test(window)) {
      unbracketed.push(`line ${start + 1} rebuilds content without restoring focus`);
    }
  }
  assert.deepEqual(
    unbracketed,
    [],
    'a rebuild that captures focus and never restores it drops the user out ' +
    'of the dialog and onto the document body'
  );

  assert.equal(
    /captureModalRerenderFocus/.test(CLUSTER_SOURCE),
    false,
    'the cluster shell builds its content once and must not grow a rebuild ' +
    'path without the focus handling that goes with it'
  );
});

test('the two-shell decision is recorded where the next reader will find it', () => {
  requireClause(
    CLUSTER_SOURCE,
    /Why this is not the only community annotation modal shell/,
    'modal-shell.js must state why a second shell exists'
  );
  for (const [label, source] of [
    ['modal-shell.js', CLUSTER_SOURCE],
    ['community-annotation-voting-modal.js', VOTING_SOURCE],
  ]) {
    requireClause(
      source,
      /community-annotation-modal-shell-parity-contract\.test\.mjs/,
      `${label} must point at the test that keeps the two shells in agreement`
    );
  }
});
