/**
 * The histories the State panel's specs draw (history records, built with
 * `history-v2-builder.mjs`), by name: a spec installs one in the page with
 * `installScene(name)` (the page's policy runs no code made from text, so a
 * scene is a function of this module, never a string).
 */
import { installFakeHistory } from './history-v2-fake.mjs';

const filters = { touches: ['filters'] };
const camera = { type: 'camera.set', touches: ['camera'] };

/** s0 Opened · s1 Colored · s2 Hid alpha (fork) · s3 Hid gamma · s4 Colored by score; from s2: s5 Kept a view, s6 Renamed (Branch 1). */
function forkedSteps(b) {
  b.step('Colored by cell_type');
  const alpha = b.step('Hid alpha of cell_type', filters);
  b.step('Hid gamma of cell_type', filters);
  b.step('Colored by score');
  b.jump(alpha);
  b.step('Kept a view', { type: 'view.keep', touches: ['views'] });
  b.step('Renamed 0 to T cells', { type: 'category.rename', touches: ['field-overlays'] });
}

export const SCENES = Object.freeze({
  /** Branch 1 shown at its first step, its second undone. */
  forked: b => { forkedSteps(b); b.undo(1); },
  /** Branch 1 shown at its tip. */
  forkedAtTip: b => forkedSteps(b),
  long: b => {
    b.step('A label that is long enough to need a second line in the sidebar, and a third on a phone, never cut short');
    b.branchHere('s0', 'A branch with a long name that wraps rather than ending in an ellipsis');
    b.step('Short');
    b.jump('s1');
  },
  steps2000: b => { for (let i = 0; i < 2000; i++) b.step(`Step ${i + 1}`, filters); },
  recolors: b => { b.step('Colored'); b.steps(3, 'Recolored', { touches: ['colors'] }); b.step('Hid', filters); },
  twoSteps: b => { b.step('A'); b.step('B'); },
  /** 10 000 steps and 100 branches (the stress suite's graph): 100 branches of 10 steps from the first 100 steps, a main line to 10 000, a third of it camera moves. */
  stress10k100: b => {
    const forks = [];
    for (let i = 0; i < 100; i++) forks.push(b.step(`Step ${i}`));
    for (const id of forks) {
      b.jump(id);
      b.steps(10, `Branch step from ${id}`);
    }
    b.jump(forks[forks.length - 1]);
    while (b.tracker.steps.length < 10_000) b.step(`Main ${b.tracker.steps.length}`, b.tracker.steps.length % 3 === 0 ? camera : {});
  },
  /** Main s0–s3; Branch 1 from s1 (s4, s5); Branch 2 from s4 (s6): a branch with a sub-branch. Main shown at its tip. */
  nested: b => {
    b.step('Colored by cell_type');
    b.step('Hid alpha of cell_type', filters);
    b.step('Hid gamma of cell_type', filters);
    b.jump('s1');
    const first = b.step('Kept a view', { type: 'view.keep', touches: ['views'] });
    b.step('Renamed 0 to T cells', { type: 'category.rename', touches: ['field-overlays'] });
    b.jump(first);
    b.step('Colored by score');
    b.jump('s3');
  },
  /** Steps with author badges (an agent outside a turn, a notebook) and labels that need room beside them. */
  badges: b => {
    b.as({ origin: 'agent', agent: 'Claude', model: 'claude-sonnet-4-6' });
    b.step('Hid the doublets after the quality check', filters);
    b.as({ origin: 'host', host: 'python' });
    b.step('Colored by the leiden clusters at resolution one', { type: 'color.by', touches: ['active-field'] });
    b.as({ origin: 'user' });
    b.step('Kept a view');
  },
  /** The user walk: QC steps, camera moves, a bookmark, an agent's turn with a note, 40 color tweaks, a mistake last. */
  walk: b => {
    b.step('Colored by cell_type');
    b.step('Hid low-quality cells', filters);
    b.step('Hid doublets', filters);
    b.step('Opened the Filters section', { type: 'layout.section.open', touches: ['layout'] });
    b.step('Hid cells with high mitochondrial counts', filters);
    b.steps(4, 'Moved the camera', camera);
    const before = b.step('Kept a view', { type: 'view.keep', touches: ['views'] });
    b.bookmark(before, 'Before reclustering');
    b.as({ origin: 'agent', agent: 'Claude', model: 'claude-sonnet-4-6', turn: 'turn-1' }, 'Find T cell markers');
    b.step('Ran DE: T cells vs B cells', { type: 'analysis.run', touches: ['analysis'] });
    const cd3 = b.step('Colored by CD3E');
    b.note(cd3, 'Top hits match the *paper*.');
    b.as({ origin: 'user' });
    for (let i = 0; i < 40; i++) b.step(`Changed the color map (${i + 1})`, { type: 'color.continuous.colormap', touches: ['colors'] });
    b.step('Renamed 0 to T cells', { type: 'category.rename', touches: ['field-overlays'] });
    b.step('Oops: hid every B cell', filters);
  },
});

/** Put the scene `name` in the page (inside `page.evaluate`). */
export function installScene(name) {
  const build = SCENES[name];
  if (build === undefined) throw new RangeError(`There is no scene "${name}"`);
  return installFakeHistory(build);
}
