/**
 * A stand-in history core for the State panel's specs: the records of
 * `app/history/model.js` (built with `history-v2-builder.mjs`), and the
 * history actions the panel dispatches, provided on a dispatcher, acting on
 * the records only (no state domain is put back: the viewer does not move).
 * Each edit is journaled whole, so Recently deleted restores it.
 *
 * It is a test helper, installed in a page by `installFakeHistory`.
 */
import { trackerBuilder } from './history-v2-builder.mjs';
import { createBy, createJournalEntry, emptyPatch, idOf, validateTracker } from '../../assets/js/app/history/model.js';

/**
 * @param {{dispatcher: object, build?: (builder: ReturnType<typeof trackerBuilder>) => void, now?: () => number}} options
 */
export function createFakeHistory({ dispatcher, build = () => {}, now = () => Date.now() }) {
  const builder = trackerBuilder();
  build(builder);
  let tracker = builder.build();
  const listeners = new Set();
  const snapshots = new Map();
  const staleSteps = new Map();
  let pending = null;
  let pausedChoice = { next: null, remembered: null };
  const choices = [];
  const user = createBy({ origin: 'user' });

  const notify = kind => { for (const listener of [...listeners]) listener({ kind }); };
  const step = id => tracker.steps.find(each => each.id === id);
  const branch = ref => tracker.branches.find(each => each.id === ref || each.name === ref);
  const refuse = message => { throw Object.assign(new Error(message), { code: 'refused' }); };
  function pathTo(id) {
    const out = [];
    for (let at = step(id); at; at = at.parent === null ? undefined : step(at.parent)) out.unshift(at);
    return out;
  }
  function own(branchId) {
    const record = branch(branchId);
    const out = [];
    for (let at = step(record.tip); at && at.branch === branchId; at = at.parent === null ? undefined : step(at.parent)) out.unshift(at);
    return out;
  }
  /** Keep the whole tracker as it was, as a journal entry (Recently deleted restores it). */
  /**
   * Journal an edit; `snapshot` is the tracker before it (taken by the edit
   * when it builds the entry afterwards: a squash names the steps it
   * replaced and made in its patches).
   */
  function journal(op, label, { snapshot = structuredClone(tracker), before = [], after = [] } = {}) {
    const id = idOf('journal', tracker.nextJournal++);
    snapshots.set(id, snapshot);
    tracker.journal.push(createJournalEntry({
      id, op, at: now(), by: user, label,
      before: { ...emptyPatch(), steps: before.map(each => structuredClone(each)) },
      after: { ...emptyPatch(), steps: after.map(each => structuredClone(each)) },
    }));
    return id;
  }
  function edited(id) {
    validateTracker(tracker);
    notify('edited');
    return id;
  }
  function moveTo(id) {
    if (tracker.paused !== null) {
      choices.push(pausedChoice.next ?? pausedChoice.remembered ?? 'keep');
      pausedChoice.next = null;
    }
    const target = step(id);
    const onPath = pathTo(branch(tracker.activeBranch).tip).some(each => each.id === id);
    if (!onPath) tracker.activeBranch = target.branch;
    tracker.headId = id;
    pending = null;
    notify('moved');
    return { head: id };
  }

  const handlers = {
    'history.undo': () => {
      const parent = step(tracker.headId).parent;
      if (parent === null) return { moved: false, head: tracker.headId };
      moveTo(parent);
      return { moved: true, head: parent };
    },
    'history.redo': () => {
      const path = pathTo(branch(tracker.activeBranch).tip);
      const at = path.findIndex(each => each.id === tracker.headId);
      if (at === path.length - 1) return { moved: false, head: tracker.headId };
      moveTo(path[at + 1].id);
      return { moved: true, head: tracker.headId };
    },
    'history.jump': ({ step: id }) => moveTo(id),
    'history.branch.switch': ({ branch: ref }) => {
      const record = branch(ref);
      tracker.activeBranch = record.id;
      tracker.headId = record.tip;
      notify('moved');
      return { branch: { id: record.id, name: record.name }, head: record.tip };
    },
    'history.branch.create': ({ step: id, name }) => {
      moveTo(id);
      pending = { name: name ?? `Branch ${tracker.nextBranch}`, from: id };
      notify('edited');
      return { pending: pending.name, from: id, head: id };
    },
    'history.branch.cancel': () => {
      const was = pending?.name ?? null;
      pending = null;
      notify('edited');
      return { cancelled: was };
    },
    'history.branch.rename': ({ branch: ref, name }) => {
      const record = branch(ref);
      const entry = journal('branch.rename', `Renamed branch “${record.name}” to “${name}”`);
      record.name = name;
      return { branch: { id: record.id, name }, journal: edited(entry) };
    },
    'history.branch.archive': ({ branch: ref, archived }) => {
      const record = branch(ref);
      const entry = journal('branch.archive', `${archived ? 'Archived' : 'Unarchived'} “${record.name}”`);
      record.archived = archived;
      return { branch: { id: record.id, name: record.name }, archived, journal: edited(entry) };
    },
    'history.branch.set-main': ({ branch: ref }) => {
      const record = branch(ref);
      const entry = journal('branch.set-main', `Made “${record.name}” main`);
      tracker.mainBranch = record.id;
      return { branch: { id: record.id, name: record.name }, journal: edited(entry) };
    },
    'history.branch.lock': ({ branch: ref, locked }) => {
      const record = branch(ref);
      const entry = journal('branch.lock', `${locked ? 'Locked' : 'Unlocked'} “${record.name}”`);
      record.locked = locked;
      return { branch: { id: record.id, name: record.name }, locked, journal: edited(entry) };
    },
    'history.branch.delete': ({ branch: ref, with_sub_branches: withSubBranches = false }) => {
      const record = branch(ref);
      if (record.id === tracker.mainBranch) refuse('Make another branch main first.');
      // The branch, and with sub-branches every branch starting from its steps (and theirs).
      const gone = [record];
      for (let at = 0; at < gone.length; at++) {
        const steps = own(gone[at].id);
        const children = tracker.branches.filter(each => steps.some(s => s.id === each.base));
        if (children.length > 0 && !withSubBranches) refuse('The stand-in history deletes branches without sub-branches only.');
        gone.push(...children.filter(each => !gone.includes(each)));
      }
      const steps = gone.flatMap(each => own(each.id));
      const entry = journal('branch.delete', `Deleted branch “${record.name}” (${steps.length} steps)`);
      const ids = new Set(steps.map(each => each.id));
      const base = step(record.base);
      for (const each of tracker.steps) if (!ids.has(each.id)) each.children = each.children.filter(id => !ids.has(id));
      tracker.steps = tracker.steps.filter(each => !ids.has(each.id));
      tracker.branches = tracker.branches.filter(each => !gone.includes(each));
      if (ids.has(tracker.headId) || gone.some(each => each.id === tracker.activeBranch)) {
        tracker.headId = base.id;
        tracker.activeBranch = base.branch;
      }
      return { branches: gone.map(each => ({ id: each.id, name: each.name })), steps: steps.length, results: 0, kept_views: 0, replays: 0, absorbed_by: null, head: tracker.headId, journal: edited(entry) };
    },
    'history.step.delete': ({ step: id }) => {
      const target = step(id);
      const entry = journal('step.delete', `Deleted step ${id.slice(1)} “${target.label}”`);
      const parent = step(target.parent);
      parent.children = parent.children.flatMap(child => (child === id ? target.children : [child]));
      for (const child of target.children) step(child).parent = parent.id;
      for (const record of tracker.branches) {
        if (record.tip === id) record.tip = parent.branch === record.id ? parent.id : target.children[0] ?? parent.id;
        if (record.base === id) record.base = parent.id;
      }
      tracker.steps = tracker.steps.filter(each => each.id !== id);
      tracker.branches = tracker.branches.filter(record => tracker.steps.some(s => s.branch === record.id && s.id === record.tip) || record.base === null);
      if (tracker.headId === id) tracker.headId = parent.id;
      return { reapplied: [], flagged: [], head: tracker.headId, journal: edited(entry) };
    },
    'history.group.create': ({ from, to, name }) => {
      const entry = journal('group.create', `Grouped steps ${from.slice(1)}–${to.slice(1)} as “${name}”`);
      const groupId = idOf('group', tracker.nextGroup++);
      tracker.groups.push({ id: groupId, name, createdAt: now(), by: user, notes: [] });
      let count = 0;
      for (let at = step(to); at; at = step(at.parent)) {
        at.group = groupId;
        count++;
        if (at.id === from) break;
      }
      return { group: { id: groupId, name }, steps: count, journal: edited(entry) };
    },
    'history.group.extend': ({ group: ref, to }) => {
      const record = tracker.groups.find(each => each.id === ref || each.name === ref);
      const entry = journal('group.extend', `Extended the group “${record.name}” to step ${to.slice(1)}`);
      for (let at = step(to); at && at.group !== record.id; at = step(at.parent)) at.group = record.id;
      return { group: { id: record.id, name: record.name }, steps: tracker.steps.filter(each => each.group === record.id).length, journal: edited(entry) };
    },
    'history.group.rename': ({ group: ref, name }) => {
      const record = tracker.groups.find(each => each.id === ref || each.name === ref);
      const entry = journal('group.rename', `Renamed the group “${record.name}” to “${name}”`);
      record.name = name;
      return { group: { id: record.id, name }, journal: edited(entry) };
    },
    'history.group.remove': ({ group: ref }) => {
      const record = tracker.groups.find(each => each.id === ref || each.name === ref);
      const entry = journal('group.remove', `Ungrouped “${record.name}”`);
      for (const each of tracker.steps) if (each.group === record.id) each.group = null;
      tracker.groups = tracker.groups.filter(each => each !== record);
      return { group: { id: record.id, name: record.name }, journal: edited(entry) };
    },
    'history.squash': ({ from, to }) => {
      const run = [];
      for (let at = step(to); at; at = step(at.parent)) {
        run.unshift(at);
        if (at.id === from) break;
      }
      const snapshot = structuredClone(tracker);
      const replaced = run.map(each => structuredClone(each));
      const first = run[0];
      const last = run[run.length - 1];
      const touches = [...new Set(run.flatMap(each => each.touches))];
      // The squashed step takes the id of the range's last step, on its first one's parent.
      Object.assign(last, {
        kind: 'squashed', type: null, params: null, v: null, code: null, coalesceKey: null, replayOf: null,
        label: `Merged ${run.length} steps: ${touches.join(', ')}`, at: first.at, parent: first.parent, touches,
        before: Object.fromEntries(touches.map(d => [d, run.find(each => d in each.before).before[d]])),
        after: Object.fromEntries(touches.map(d => [d, [...run].reverse().find(each => d in each.after).after[d]])),
        squashed: { cause: 'steps', count: run.length, by: [user], carried: { notes: run.slice(0, -1).flatMap(each => each.notes.map(n => n.id)), bookmarks: run.slice(0, -1).map(each => each.bookmark).filter(Boolean) } },
        notes: run.flatMap(each => each.notes), bookmark: last.bookmark,
      });
      const parent = step(first.parent);
      parent.children = parent.children.map(child => (child === first.id ? last.id : child));
      const gone = new Set(run.slice(0, -1).map(each => each.id));
      tracker.steps = tracker.steps.filter(each => !gone.has(each.id));
      for (const record of tracker.branches) if (record.base !== null && gone.has(record.base)) record.base = parent.id;
      if (gone.has(tracker.headId)) tracker.headId = last.id;
      const entry = journal('squash', `Merged ${run.length} steps into one`, { snapshot, before: replaced, after: [last] });
      return { step: last.id, squashed: run.length, groups_removed: [], head: tracker.headId, journal: edited(entry) };
    },
    'history.recording.pause': () => {
      tracker.paused = { at: now(), by: [user], draft: null };
      pausedChoice = { next: null, remembered: null };
      notify('recording');
      return { since: tracker.paused.at, head: tracker.headId };
    },
    'history.recording.resume': () => {
      tracker.paused = null;
      pausedChoice = { next: null, remembered: null };
      notify('recording');
      return { squashed: null, head: tracker.headId };
    },
    'history.note.add': ({ target, text }) => {
      const entry = journal('note.add', 'Added a note');
      const id = idOf('note', tracker.nextNote++);
      const note = { id, text, by: user, at: now(), editedAt: null, fromReply: false };
      const holder = target.step ? step(target.step) : target.branch ? branch(target.branch)
        : target.group ? tracker.groups.find(each => each.id === target.group) : target.turn ? tracker.turns.find(each => each.id === target.turn) : tracker;
      holder.notes.push(note);
      return { note: id, journal: edited(entry) };
    },
    'history.note.edit': ({ note: id, text }) => {
      const entry = journal('note.edit', 'Edited a note');
      const holders = [...tracker.steps, ...tracker.branches, ...tracker.groups, ...tracker.turns, tracker];
      const note = holders.flatMap(each => each.notes).find(each => each.id === id);
      Object.assign(note, { text, editedAt: now() });
      return { note: id, journal: edited(entry) };
    },
    'history.note.remove': ({ note: id }) => {
      const entry = journal('note.remove', 'Removed a note');
      for (const holder of [...tracker.steps, ...tracker.branches, ...tracker.groups, ...tracker.turns, tracker]) {
        holder.notes = holder.notes.filter(each => each.id !== id);
      }
      return { note: id, journal: edited(entry) };
    },
    'history.bookmark.set': ({ step: id, name }) => {
      const entry = journal('bookmark.set', name === null ? 'Removed a bookmark' : `Bookmarked step ${id.slice(1)} “${name}”`);
      step(id).bookmark = name;
      return { step: id, bookmark: name, journal: edited(entry) };
    },
    'history.turn.undo': ({ turn }) => {
      const first = pathTo(tracker.headId).find(each => each.by.turn === turn);
      if (first) moveTo(first.parent);
      return { head: tracker.headId, removed: 0, other_branches: [], journal: null };
    },
    'history.journal.undo': ({ entry }) => {
      const before = snapshots.get(entry);
      if (before === undefined) refuse(`There is no entry ${entry}`);
      const kept = tracker.journal.filter(each => each.id !== entry && idNumberOf(each.id) > idNumberOf(entry));
      tracker = before;
      tracker.journal = tracker.journal.filter(each => each.id !== entry);
      void kept;
      notify('edited');
      return { entry, restored: 'exact', journal: entry };
    },
    'history.journal.empty': ({ entry }) => {
      let purged = 0;
      for (const each of tracker.journal) {
        if ((entry === undefined || each.id === entry) && !each.purged) {
          Object.assign(each, { purged: true, before: null, after: null });
          snapshots.delete(each.id);
          purged++;
        }
      }
      notify('edited');
      return { purged, bytes: 0 };
    },
    'history.diff': ({ a, b }) => {
      const at = id => Object.assign({}, ...pathTo(id).map(each => each.after));
      const va = at(a.step);
      const vb = at(b.step);
      const pa = new Set(pathTo(a.step).map(each => each.id));
      const common = [...pathTo(b.step)].reverse().find(each => pa.has(each.id))?.id ?? null;
      const domains = Object.keys(vb).filter(d => va[d] !== vb[d]).map(d => ({ domain: d, name: d, lines: ['Changed'] }));
      return { a: { tracker: { id: tracker.id, name: tracker.name }, step: a.step }, b: { tracker: { id: tracker.id, name: tracker.name }, step: b.step }, common, domains };
    },
    'history.pseudocode': () => ({ tracker: { id: tracker.id, name: tracker.name }, branch: { id: tracker.activeBranch, name: branch(tracker.activeBranch).name }, text: pathTo(tracker.headId).map(each => each.code ?? `# ${each.label}`).join('\n') }),
    'history.methods': () => ({ tracker: { id: tracker.id, name: tracker.name }, branch: { id: tracker.activeBranch, name: branch(tracker.activeBranch).name }, text: `Methods: ${pathTo(tracker.headId).length - 1} steps.` }),
    'history.share': ({ content = 'history' }) => ({ file: 'Fixture.cellucid-session', bytes: 1024, content, trackers: [{ id: tracker.id, name: tracker.name }], steps: tracker.steps.length - 1 }),
    'history.save': ({ name = 'Saved', content = 'history' }) => ({ saved: 'state-1', name, content, bytes: 1024, steps: tracker.steps.length - 1 }),
    'history.clear': () => refuse('The stand-in history does not clear.'),
  };
  /** Every action the stand-in ran, in order (the specs count dispatches). */
  const acted = [];
  // An action the page's own core already provides (its exports, its files) stays the core's.
  const removers = Object.entries(handlers).filter(([type]) => dispatcher.catalog.has(type) && !dispatcher.provided(type))
    .map(([type, handler]) => dispatcher.provide(type, (params, context) => { acted.push(type); return handler(params, context); }));

  /**
   * The tracker as the core keeps it while it runs: steps, branches, groups
   * and turns as maps by id (`app/history/tree.js`), made again after each
   * change (the records are the same objects).
   */
  let live = null;
  let liveOf = null;
  let version = 0;
  const bump = () => { version++; };
  listeners.add(bump);
  function liveTracker() {
    if (live !== null && liveOf === version) return live;
    const byId = list => new Map(list.map(record => [record.id, record]));
    live = { ...tracker, steps: byId(tracker.steps), branches: byId(tracker.branches), groups: byId(tracker.groups), turns: byId(tracker.turns), chats: new Map() };
    liveOf = version;
    return live;
  }

  return {
    get active() { return liveTracker(); },
    /** The records as the model lists them (the specs' reads). */
    get records() { return tracker; },
    chatsOf: () => [],
    setChat: () => {},
    pending: () => (pending === null ? null : { ...pending }),
    get acted() { return [...acted]; },
    /** The paused choices the moves made ('keep' or 'discard'), for the specs. */
    get pausedChoices() { return [...choices]; },
    trackers: () => [liveTracker()],
    allTrackers: () => [liveTracker()],
    /** It keeps no values: nothing in memory to warn of (the panel's memory line, `memory-dialog.js`). */
    pool: Object.freeze({ byteLength: () => 0 }),
    memoryParts: () => ({ total: 0, parts: [] }),
    catalog: dispatcher.catalog,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    undo: () => dispatcher.dispatch('history.undo', {}),
    /** As the core answers them (`history.js` `canUndo`, `canRedo`): what the panel's Undo and Redo ask. */
    canUndo: () => step(tracker.headId).parent !== null,
    canRedo: () => {
      const path = pathTo(branch(tracker.activeBranch).tip);
      const at = path.findIndex(each => each.id === tracker.headId);
      return at !== -1 && at < path.length - 1;
    },
    idle: async () => {},
    stale: () => [...staleSteps.values()],
    pausedChanges: () => (tracker.paused === null ? null : { tracker: tracker.id, domains: ['colors'], remembered: pausedChoice.remembered }),
    setPausedChoice(choice, { remember = false } = {}) {
      if (remember) pausedChoice.remembered = choice; else pausedChoice.next = choice;
    },
    /** The core's dry runs (`branchDeletePlan`, `deletePlan`), for the records the stand-in keeps. */
    branchDeletePlan(ref, { withSubBranches = false } = {}) {
      const record = branch(ref);
      const steps = own(record.id);
      const subs = withSubBranches ? tracker.branches.filter(each => steps.some(s => s.id === each.base)) : [];
      const all = [...steps, ...subs.flatMap(sub => own(sub.id))];
      const ids = new Set(all.map(each => each.id));
      let head = tracker.headId;
      while (ids.has(head)) head = step(head).parent;
      return {
        branches: [record, ...subs].map(each => ({ id: each.id, name: each.name })), steps: all.length,
        first: steps[0]?.id ?? null, last: steps.at(-1)?.id ?? null,
        results: all.filter(each => each.touches.includes('analysis')).length, kept_views: 0, replays: 0, absorbed_by: null, head,
      };
    },
    deletePlan(id) {
      const target = step(id);
      const later = tracker.steps.filter(each => idNumberOf(each.id) > idNumberOf(id) && pathTo(each.id).includes(target)
        && each.touches.some(domain => target.touches.includes(domain)));
      return { reapply: later.map(each => each.id), ms: 0 };
    },
    /** Mark a step's result stale (the specs' stand-in for provenance). */
    markStale(id, causeId, inputs) { staleSteps.set(id, { step: step(id), cause: step(causeId) ?? null, inputs }); notify('edited'); },
    /** Change the records through the builder's appends (a step as the person or an agent takes it). */
    append(label, fields, by = null) {
      if (by !== null) builder.as(by);
      const id = builder.step(label, fields);
      tracker = builder.build();
      notify('step');
      return id;
    },
    destroy() { for (const remove of removers) remove(); listeners.clear(); },
  };
}

function idNumberOf(id) {
  return Number(id.slice(1));
}

/**
 * Put a stand-in history in the page in place of the page's own (whose
 * providers are taken off): the State panel then draws and acts on it.
 * Call inside the page (`page.evaluate`).
 *
 * @param {(builder: object) => void} build
 */
export async function installFakeHistory(build) {
  const { getActions } = await import('/assets/js/app/actions/index.js');
  const { getCurrentHistory, setCurrentHistory } = await import('/assets/js/app/history/current.js');
  const real = getCurrentHistory();
  real?.destroy();
  const fake = createFakeHistory({ dispatcher: getActions(), build });
  setCurrentHistory(fake);
  globalThis.__fakeHistory = fake;
  return fake;
}
