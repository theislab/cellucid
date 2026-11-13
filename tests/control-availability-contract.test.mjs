/**
 * Every input and select the app turns off says why 
 * `ui/core/control-availability.js` is the one way, so the dimmed control's
 * tooltip and a refused `setting.set` give the owner's reason, never a guess
 * (such as "switched off by another setting" said of a dataset with no
 * vector field). A new `.disabled =` / `toggleAttribute('disabled')` in the app is
 * refused here until it goes through `setControlAvailability`, or is listed
 * below as a button, an option or not a control at all.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  setControlAvailability,
  unavailableReasonOf,
} from '../assets/js/app/ui/core/control-availability.js';
import { repositoryPath, sourceFiles } from './helpers/source-files.mjs';

test('a control turned off carries its reason; turned on, its own title is back', () => {
  const control = { disabled: false, title: 'Opacity of the overlay' };
  setControlAvailability(control, 'the field is loading; try again once it has loaded');
  assert.equal(control.disabled, true);
  assert.equal(control.title, 'the field is loading; try again once it has loaded');
  assert.equal(unavailableReasonOf(control), 'the field is loading; try again once it has loaded');
  setControlAvailability(control, 'another reason');
  setControlAvailability(control, null);
  assert.equal(control.disabled, false);
  assert.equal(control.title, 'Opacity of the overlay', 'the title it had before it was turned off');
  assert.equal(unavailableReasonOf(control), null);
  // A title its owner set while it was on stays.
  const owned = { disabled: false, title: '' };
  setControlAvailability(owned, 'busy');
  owned.title = 'Shows t-SNE';
  setControlAvailability(owned, null);
  assert.equal(owned.title, 'Shows t-SNE');
  for (const reason of ['', '  ', undefined, 3]) {
    assert.throws(() => setControlAvailability({ disabled: false, title: '' }, reason), /says why/);
  }
  assert.equal(unavailableReasonOf({ disabled: true, title: '' }), null, 'disabled another way: no reason known');
});

test('a refused setting gives the reason its owner gave', () => {
  const source = readFileSync(repositoryPath('assets/js/app/state-serializer/ui-controls.js'), 'utf8');
  assert.match(source, /import \{ unavailableReasonOf \} from '\.\.\/ui\/core\/control-availability\.js';/);
  assert.match(source, /const reason = unavailableReasonOf\(element\) \?\? 'it is not ready yet';/);
  assert.doesNotMatch(source, /switched off by another setting/);
});

/**
 * Receivers of `.disabled =` that are not an input or a select: a button
 * (its purpose says why it is dimmed: nothing to undo, no next page), an
 * `<option>`, a `dataset` flag. By file, receiver.
 */
const NOT_INPUT_OR_SELECT = new Map([
  ['app/ui/category-builder.js', ['this._els.toggle']],
  ['app/ui/components/controls.js', ['root.dataset']],
  ['app/ui/modules/community-annotation-voting-modal.js', ['previous', 'next', 'previousSuggestionPage', 'nextSuggestionPage']],
  ['app/ui/modules/gene-read-control.js', ['dom.action']],
  ['app/ui/modules/kept-stores-dialog.js', ['dom.removeSelected', 'dom.removeAll', 'dom.persist']],
  ['app/ui/modules/group-categories-dialog.js', ['dom.apply']],
  ['app/ui/modules/data-mapping-controls.js', ['panel.revert', 'panel.apply']],
  ['app/ui/modules/velocity-overlay-controls.js', ['placeholder']],
  ['app/ui/modules/cite-dialog.js', ['copyReference', 'copyBibtex']],
  ['app/ui/modules/subsample-control.js', ['dom.apply']],
  ['app/ui/modules/dataset-controls.js', ['emptyMsg']],
  ['app/ui/modules/highlight/step-controls.js', ['mirror.undo', 'mirror.confirm']],
  ['app/ui/modules/data-mapping/groups.js', ['element']],
  ['app/ui/modules/data-mapping/dom.js', ['root.dataset', 'remove', 'isDefault', 'add']],
  ['app/ui/modules/state/saved-states-dialog.js', ['open', 'replay']],
  ['app/ui/modules/state/notes.js', ['ok']],
  ['app/ui/modules/state/index.js', ['item', 'dom.recording']],
  ['app/ui/modules/state/branch-map-dialog.js', ['archive', 'remove']],
  ['app/ui/modules/state/tour.js', ['ui.previous', 'ui.next', 'ui.pause']],
  ['app/ui/modules/state/recently-deleted.js', ['dom.deletedEmpty']],
  ['app/ui/modules/state/share-dialog.js', ['save']],
  ['app/ui/modules/state/step-details.js', ['element']],
  ['app/ui/modules/my-datasets/dialog.js', ['open', 'resume', 'exportConfirm']],
  ['app/ui/modules/community-annotation/controls-panel.js', ['rebuild', 'apply', 'reset']],
  ['app/ui/modules/community-annotation/github-connection-flow.js', ['pager.previous', 'pager.next']],
  ['app/agent/chat/index.js', ['dom.forget']],
  ['app/agent/chat/transcript-view.js', ['parts.steps', 'parts.undo']],
  ['app/agent/connect/index.js', ['dom.copy', 'dom.manage']],
  ['app/agent/connect/approval-dialog.js', ['dom.allow', 'dom.deny']],
  ['app/agent/presence/index.js', ['forget']],
  ['app/agent/connect/connections-dialog.js', ['dom.forgetYes']],
]);

/** A button or an option by its name. */
const BUTTON_OR_OPTION = /(Btn|Button|button|btn|Option|option)$/;

test('no input or select is turned off but through setControlAvailability', () => {
  const unlisted = [];
  const listedSeen = new Set();
  for (const { path, relative } of sourceFiles('assets/js/app')) {
    const file = `app/${relative}`;
    if (file === 'app/ui/core/control-availability.js') continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if (/(toggleAttribute|setAttribute|removeAttribute)\(\s*['"]disabled['"]/.test(line)) {
        unlisted.push(`${file}:${index + 1}: ${line.trim()}`);
        return;
      }
      for (const match of line.matchAll(/([A-Za-z_$][\w$.]*)\.disabled\s*=(?!=)/g)) {
        const receiver = match[1];
        const last = receiver.split('.').at(-1);
        if (BUTTON_OR_OPTION.test(last)) continue;
        if (NOT_INPUT_OR_SELECT.get(file)?.includes(receiver)) {
          listedSeen.add(`${file} ${receiver}`);
          continue;
        }
        unlisted.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(unlisted, [], 'turn an input or a select off with setControlAvailability(control, reason)');
  const stale = [...NOT_INPUT_OR_SELECT].flatMap(([file, receivers]) => receivers
    .filter(receiver => !listedSeen.has(`${file} ${receiver}`))
    .map(receiver => `${file} ${receiver}`));
  assert.deepEqual(stale, [], 'a listed receiver no longer in its file: remove it from the list');
});
