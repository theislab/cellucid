/**
 * The community annotation dialogs are app dialogs: a native `<dialog>`
 * opened through `wireAppDialog` (`ui/components/app-dialog.js`), the one
 * modal implementation of the app. `community-annotation/modal-shell.js`
 * (`showClusterModal`: the identity profile editor, the GitHub connection
 * flow) and `community-annotation-voting-modal.js` (`showModal`, and
 * `showSecondaryModal` for the details over it) build theirs on it; what is
 * theirs alone is the primary/secondary cascade, retiring the voting render
 * lifecycle before the dialog leaves the page, and the secondary's re-render
 * with focus kept across each rebuild.
 *
 * This test keeps them there: no hand-built overlay, Tab trap or Escape
 * protocol comes back in either, and the rebuild focus handling stays.
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
const IDENTITY_PROFILE = fileURLToPath(new URL(
  '../assets/js/app/ui/modules/community-annotation/identity-profile-modal.js',
  import.meta.url
));

const CLUSTER_SOURCE = readFileSync(CLUSTER_SHELL, 'utf8');
const VOTING_SOURCE = readFileSync(VOTING_SHELL, 'utf8');
const IDENTITY_SOURCE = readFileSync(IDENTITY_PROFILE, 'utf8');

const SHELLS = [
  ['the cluster modal shell', CLUSTER_SOURCE],
  ['the voting modal shell', VOTING_SOURCE],
];

/** `assert.ok` over a regex, so a failure names the clause instead of dumping the file. */
function requireClause(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

test('every community annotation dialog is an app dialog', () => {
  for (const [label, source] of SHELLS) {
    requireClause(
      source,
      /import \{ wireAppDialog \} from '[./]+\/components\/app-dialog\.js';/,
      `${label} must build its dialog on wireAppDialog`
    );
    requireClause(
      source,
      /el\('dialog', \{ className: 'dialog-layer community-annotation-dialog' \}\)/,
      `${label} must be a <dialog> drawn as a dialog layer`
    );
    requireClause(
      source,
      /setAttribute\('aria-labelledby',/,
      `${label} must name its dialog from the title it rendered`
    );
    requireClause(
      source,
      /\.open\([^)]*\{ focus: closeBtn \}\)/,
      `${label} must open with focus on its Close button`
    );
  }
  assert.equal(
    (VOTING_SOURCE.match(/wireAppDialog\(dialog,/g) ?? []).length,
    2,
    'the voting dialog and the details dialog over it are each an app dialog'
  );
});

test('no community annotation dialog brings back a hand-built modal', () => {
  const sources = [...SHELLS, ['identity-profile-modal.js', IDENTITY_SOURCE]];
  for (const [label, source] of sources) {
    for (const [pattern, what] of [
      [/aria-modal/, 'an aria-modal overlay'],
      [/key !== 'Tab'|key === 'Tab'/, 'a Tab trap'],
      [/addEventListener\('keydown', onKeyDown, true\)/, 'a capture-phase key trap'],
      [/modal-background-owner|claimModalDocumentLayer/, 'a hand-built inert background'],
      [/data-esc-cancel|ESCAPE_OWNER/, 'an Escape protocol of its own (content takes Escape with preventDefault)'],
      [/MutationObserver\(\(\) => \{\s*if \(!document\.body\.contains/, 'a watch for the voting dialog leaving (it closes the details itself)'],
    ]) {
      assert.equal(pattern.test(source), false, `${label} has ${what}`);
    }
  }
});

test('the voting dialog closes the details dialog over it first', () => {
  requireClause(
    VOTING_SOURCE,
    /const close = \(\) => \{\s*closeSecondary\(\);\s*owner\.close\(\);\s*\};/,
    'closing the voting dialog must close the details dialog before it hands focus back'
  );
  requireClause(
    VOTING_SOURCE,
    /\['secondary modal', closeSecondary\],\s*\['owned modal lifecycle', onClose\],\s*\['modal dialog', \(\) => dialog\.remove\(\)\]/,
    'the voting render lifecycle must retire before the dialog leaves the page'
  );
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
  // behavior a shell merge would drop, and a single surviving bracketed site
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

