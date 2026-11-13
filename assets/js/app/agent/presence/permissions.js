/**
 * @fileoverview What an agent may do in this tab without asking: the
 * person's permission settings, for every agent alike (the chat bar, and
 * Claude or ChatGPT through the connector), and the decision for one action.
 * Pure (no DOM); the settings are kept in this browser
 * (`cellucid:agent-permissions`).
 *
 * **Kinds of action**, each set to Ask, Allow or Deny:
 *
 * | Kind | What it is |
 * | --- | --- |
 * | `change` | any change in the tab: what the history can undo (color, filter, highlight, views, a new field, an analysis…), and another dataset opened (the open one's history stays kept) |
 * | `heavy` | work estimated to take longer than `HEAVY_MS` on this device and link (`estimate.ms`, from what the page measured) |
 * | `writes-file`, `deletes-saved`, `large-download`, `publishes` | what the history cannot take back (the action's `confirm`) |
 * | `pauses-recording` | pausing the history, after which a change cannot be undone on its own (`history.recording.pause`) |
 * | `unseen-link` | fetching an address the person has not seen in this tab (an action with `opensLinks`: a dataset opened by a link): an agent misled by text it read could otherwise send what it read to any host |
 *
 * The dispatcher asks at the start of every change of an agent: of its
 * `confirm` kind when that is asked before it runs, else of `change`, and
 * also `heavy` when its estimate says so; an action whose implementation
 * asks once it knows the cost (`confirmAt: 'handler'`, a download) is asked
 * again then, of its `confirm` kind alone; heavy work an implementation
 * finds only while it runs (`ctx.heavy`: the cells' totals a matrix needs,
 * what a saved state restores) is asked then as `heavy`, unless its start
 * was judged heavy already. The strictest setting of its kinds
 * decides: Deny refuses it, Ask asks the person (the agent waits), Allow
 * runs it. A grant the person gives for one chat or connection ("Allow in
 * this chat") allows that kind there until the page closes, unless the kind
 * is set to Deny since; "Always allow" sets the kind to Allow.
 *
 * **Modes** are presets of the kinds: `ask` (the default: ask before heavy or
 * irreversible work, everything else runs), `allow-undoable` (heavy work runs
 * too; still ask before what cannot be undone), `read-only` (agents only
 * read). Settings that match no preset are `custom`.
 *
 * @module app/agent/presence/permissions
 */

import { formatDuration } from '../../../utils/format-units.js';
import { webStorage } from '../../../utils/web-storage.js';
import { createListenerSet } from '../../../utils/listener-set.js';

/**
 * How long work may take before it counts as heavy: about ten seconds, the
 * time people keep their attention on a task without feedback (Nielsen 1993;
 * Miller 1968), the same measure the gene read's time target is set from
 * (`data/anndata/subsample-plan.js` `GENE_READ_TARGET_MS`). Work estimated
 * from this page's measurements to take longer asks first by default.
 */
export const HEAVY_MS = 10_000;

export const PERMISSION_KINDS = Object.freeze(['change', 'heavy', 'writes-file', 'deletes-saved', 'large-download', 'publishes', 'pauses-recording', 'unseen-link', 'replaces-unkept']);
export const PERMISSION_CHOICES = Object.freeze(['ask', 'allow', 'deny']);

/** Each choice as the settings' menus show it (a value is not a label). */
export const CHOICE_LABELS = Object.freeze({ ask: 'Ask', allow: 'Allow', deny: 'Deny' });

/** Each kind as the settings and the card name it. */
export const KIND_LABELS = Object.freeze({
  change: 'Changes in this tab',
  heavy: 'Heavy work (longer than about 10 s)',
  'writes-file': 'Writing files',
  'deletes-saved': 'Deleting what was saved',
  'large-download': 'Large downloads',
  publishes: 'Publishing',
  'pauses-recording': 'Pausing the history',
  'unseen-link': 'Opening links not seen in this tab',
  'replaces-unkept': 'Replacing work that is not kept',
});

/** What an agent is refused to do, in the sentence it reads. */
const KIND_DOINGS = Object.freeze({
  change: 'change anything in this tab',
  heavy: 'start work this long',
  'writes-file': 'write files',
  'deletes-saved': 'delete what was saved',
  'large-download': 'start large downloads',
  publishes: 'publish',
  'pauses-recording': 'pause the history',
  'unseen-link': 'open a link the person has not seen in this tab',
  'replaces-unkept': 'replace a dataset whose work is not kept',
});

const IRREVERSIBLE = Object.freeze({
  'writes-file': 'ask', 'deletes-saved': 'ask', 'large-download': 'ask', publishes: 'ask', 'pauses-recording': 'ask',
  // Not irreversible, but outbound: a request to an address only the agent named is asked in every preset that runs anything.
  'unseen-link': 'ask',
  // The person's steps on the dataset shown would be gone for good (`app/unkept-work-guard.js`).
  'replaces-unkept': 'ask',
});

export const PERMISSION_MODES = Object.freeze({
  ask: Object.freeze({ label: 'Ask before heavy or irreversible', short: 'Ask before heavy', kinds: Object.freeze({ change: 'allow', heavy: 'ask', ...IRREVERSIBLE }) }),
  'allow-undoable': Object.freeze({ label: 'Allow everything undoable without asking', short: 'Allow undoable', kinds: Object.freeze({ change: 'allow', heavy: 'allow', ...IRREVERSIBLE }) }),
  'read-only': Object.freeze({
    label: 'Read only',
    short: 'Read only',
    kinds: Object.freeze(Object.fromEntries(PERMISSION_KINDS.map(kind => [kind, 'deny']))),
  }),
});

export const DEFAULT_PERMISSIONS = Object.freeze({ kinds: PERMISSION_MODES.ask.kinds });

export const PERMISSIONS_STORAGE_KEY = 'cellucid:agent-permissions';

/** Settings of every kind, each a valid choice; what is missing or wrong is the default's. */
export function normalizePermissions(value) {
  const kinds = {};
  for (const kind of PERMISSION_KINDS) {
    const choice = value?.kinds?.[kind];
    kinds[kind] = PERMISSION_CHOICES.includes(choice) ? choice : DEFAULT_PERMISSIONS.kinds[kind];
  }
  return Object.freeze({ kinds: Object.freeze(kinds) });
}

/** The preset the settings match, or `custom`. */
export function modeOf(settings) {
  for (const [mode, preset] of Object.entries(PERMISSION_MODES)) {
    if (PERMISSION_KINDS.every(kind => settings.kinds[kind] === preset.kinds[kind])) return mode;
  }
  return 'custom';
}

/** The settings' mode in words (what an agent is told; the line's full title). */
export function permissionsSummary(settings) {
  const mode = modeOf(settings);
  return mode === 'custom' ? 'Custom' : PERMISSION_MODES[mode].label;
}

/** The settings' mode in a few words: the one line the chat settings and the Agents panel show (it fits the sidebar). */
export function permissionsLine(settings) {
  const mode = modeOf(settings);
  return mode === 'custom' ? 'Custom' : PERMISSION_MODES[mode].short;
}

/** Whether `estimate` makes an action heavy. */
export function isHeavy(estimate) {
  return Number.isFinite(estimate?.ms) && estimate.ms >= HEAVY_MS;
}

/**
 * The kinds one question of the dispatcher is about (`confirm`: the kind of
 * what the history cannot undo asked now, or null; `stage`: `start`, or
 * `handler` when the implementation asks once it knows the cost). At the
 * handler, a question without `confirm` is about heavy work found while it
 * runs (`ctx.heavy`): `heavy` when its estimate is, unless the start was
 * already judged heavy (`started`, the start's estimate); none otherwise.
 * @param {{confirm?: string|null, estimate?: object|null, stage?: 'start'|'handler', started?: object|null}} question
 */
export function kindsOf({ confirm = null, estimate = null, stage = 'start', started = null }) {
  if (stage === 'handler') {
    if (confirm !== null) return [confirm];
    return isHeavy(estimate) && !isHeavy(started) ? ['heavy'] : [];
  }
  const kinds = [confirm ?? 'change'];
  if (isHeavy(estimate)) kinds.push('heavy');
  return kinds;
}

/** The key of a grant for one chat or connection (`meta.connection`; a notebook: its language; an agent with none: that agent). */
export function grantKey(meta, kind) {
  const where = meta.connection ? `${meta.connection.kind}:${meta.connection.id}`
    : meta.origin === 'host' ? `host:${meta.host ?? ''}` : `agent:${meta.agent}`;
  return `${where}\u0000${kind}`;
}

/**
 * The decision for one question of the dispatcher about an agent's action.
 *
 * @param {{meta: object, estimate?: object|null, confirm?: string|null, stage?: 'start'|'handler', started?: object|null}} question
 * @param {{kinds: Record<string, string>}} settings
 * @param {Set<string>} grants - kinds allowed for a chat or connection (`grantKey`)
 * @returns {{decision: 'allow'|'ask'|'deny', kinds: string[], asking: string[], denied: string|null}}
 */
export function decide({ meta, estimate = null, confirm = null, stage = 'start', started = null }, settings, grants = new Set()) {
  const kinds = kindsOf({ confirm, estimate, stage, started });
  // A grant answers what the settings ask about; a kind set to Deny since stays refused.
  const choices = kinds.map(kind => {
    const choice = settings.kinds[kind];
    return [kind, choice === 'ask' && grants.has(grantKey(meta, kind)) ? 'allow' : choice];
  });
  const denied = choices.find(([, choice]) => choice === 'deny')?.[0] ?? null;
  if (denied !== null) return { decision: 'deny', kinds, asking: [], denied };
  const asking = choices.filter(([, choice]) => choice === 'ask').map(([kind]) => kind);
  return { decision: asking.length > 0 ? 'ask' : 'allow', kinds, asking, denied: null };
}

/**
 * What the settings make of one kind for one connection, as its agent is
 * told it (`bridge/agent-calls.js`, `../settings-told.js`): a kind allowed
 * there for this page is `allow`.
 * @param {{kind: string, connection: {id: string, kind: string}}} question
 * @param {{kinds: Record<string, string>}} settings
 * @param {Set<string>} grants
 * @returns {'ask'|'allow'|'deny'}
 */
export function permissionFor({ kind, connection }, settings, grants = new Set()) {
  const choice = settings.kinds[kind];
  if (choice === undefined) throw new RangeError(`There is no permission kind "${kind}"`);
  return choice === 'ask' && grants.has(grantKey({ connection }, kind)) ? 'allow' : choice;
}

/** The sentence an agent reads when the person's settings refuse an action. */
export function deniedSentence(definition, kind) {
  return `The person's settings in Cellucid do not let agents ${KIND_DOINGS[kind]}, so “${definition.title}” was not done. `
    + 'Do not try again; tell the person if it is needed (they can change it in the chat settings, Permissions).';
}

/** An estimate as one short sentence for the card, or null. */
export function estimateText(estimate) {
  if (estimate === null || estimate === undefined) return null;
  const parts = [];
  if (Number.isFinite(estimate.ms)) parts.push(`about ${formatDuration(Math.max(0, estimate.ms))} on this device`);
  if (typeof estimate.what === 'string' && estimate.what !== '') parts.unshift(estimate.what);
  return parts.length === 0 ? null : `${parts.join(', ')}.`.replace(/^./, first => first.toUpperCase());
}

/**
 * The person's permissions as an agent is told them (one paragraph): what it
 * may do without asking, what is asked, what is refused.
 */
export function permissionsForAgent(settings) {
  const by = choice => PERMISSION_KINDS.filter(kind => settings.kinds[kind] === choice).map(kind => KIND_LABELS[kind].toLowerCase());
  const lines = [];
  for (const [choice, words] of [['allow', 'run without asking'], ['ask', 'are asked of the person first (you wait for the answer)'], ['deny', 'are refused']]) {
    const kinds = by(choice);
    if (kinds.length > 0) lines.push(`${kinds.join('; ')}: ${words}`);
  }
  return `The person's permissions for agents in Cellucid now (${permissionsSummary(settings)}): ${lines.join('. ')}. Reads need no permission.`;
}

/**
 * The settings kept in this browser.
 * @param {{storage?: Storage|null}} [options]
 */
export function createPermissionStore({ storage } = {}) {
  const store = () => (storage === undefined ? webStorage('localStorage') : storage);
  let current;
  try {
    current = normalizePermissions(JSON.parse(store()?.getItem(PERMISSIONS_STORAGE_KEY) ?? 'null'));
  } catch {
    current = normalizePermissions(null);
  }
  const listeners = createListenerSet('the agent permissions');
  return Object.freeze({
    get: () => current,
    /** Set kinds (`{kind: choice}`) or a whole mode (`mode`). */
    set({ mode = null, kinds = {} } = {}) {
      const base = mode === null ? current.kinds : PERMISSION_MODES[mode]?.kinds;
      if (base === undefined) throw new RangeError(`There is no permission mode "${mode}"`);
      for (const [kind, choice] of Object.entries(kinds)) {
        if (!PERMISSION_KINDS.includes(kind) || !PERMISSION_CHOICES.includes(choice)) throw new RangeError(`"${kind}: ${choice}" is not a permission`);
      }
      current = normalizePermissions({ kinds: { ...base, ...kinds } });
      try {
        store()?.setItem(PERMISSIONS_STORAGE_KEY, JSON.stringify(current));
      } catch {
        // A browser that keeps no site data: the settings last for this page.
      }
      listeners.notify(current);
      return current;
    },
    subscribe(listener) {
      return listeners.add(listener);
    },
  });
}
