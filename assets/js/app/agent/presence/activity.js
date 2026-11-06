/**
 * @fileoverview Which agents are acting in this tab, turn by turn: what the
 * activity line shows. Pure (no DOM), fed the dispatcher's events.
 *
 * An agent turn is known by the way its agent came in, its agent's name and
 * its turn id (`meta.connection`, `meta.agent`, `meta.turn` of every dispatch
 * with `origin: 'agent'`): the chat bar (a connection of kind `chat`, the
 * conversation), a connector connection (Claude or ChatGPT through the
 * relay, kind `connector`) or a local one (an agent app on this computer
 * through `cellucid mcp`, kind `local`). Two agents of one name at once (Claude in the
 * chat and Claude Desktop through the connector) are two lines, each named
 * with its way in (`agentLabel`: "Claude (chat)", "Claude (Claude
 * Desktop)"). For each turn the line knows what runs now (the titles of the
 * actions in flight), how many steps it made, and the last step's label.
 *
 * - A turn is **acting** while an action of it runs, while a question of it
 *   waits for the person (`waitOnPerson`: the dispatcher asks before the
 *   action starts, so its card would otherwise stand under no line to Stop),
 *   or while its agent attached it (`attach`: the chat bar's turn, from the
 *   person's message on, the model thinking between calls included).
 * - Once nothing of it runs, a turn that made steps stays **done** (its line
 *   offers Undo turn) until the person dismisses it, acts themselves (a step
 *   of any other origin), or the same agent starts another turn through the
 *   same connection; a turn that only read goes away.
 * - **Stopped** and **undone** turns say so until dismissed.
 * - A turn its own surface shows (the chat bar, open, shows its own turns
 *   with their Stop and Undo turn) is not listed while it does.
 *
 * @module app/agent/presence/activity
 */

/** Which connection a turn came through, as a key part (none: the empty string). */
function connectionKeyOf(connection) {
  return connection ? `${connection.kind}:${connection.id}` : '';
}

/**
 * The key of one agent turn.
 * @param {string} agent
 * @param {string|null} turn
 * @param {{id: string, kind: string}|null} [connection]
 */
export function turnKey(agent, turn, connection = null) {
  return `${connectionKeyOf(connection)}\u0000${agent}\u0000${turn ?? ''}`;
}

/**
 * An agent named with the way it came in, as its line and its questions
 * show it: "Claude (chat)" for the chat bar; "Claude Code (local)" for an
 * agent app on this computer (`cellucid mcp`, named by the app); through the
 * connector, the client's own name when it is not the agent's ("Claude
 * (Claude Desktop)"), else the host it connected from, else "connector"; the
 * bare name when the way is not known.
 * @param {string} agent
 * @param {{kind: string, client?: string|null, host?: string|null}|null|undefined} connection
 */
export function agentLabel(agent, connection) {
  if (typeof agent !== 'string' || agent.length === 0) return 'An agent';
  if (!connection) return agent;
  if (connection.kind === 'chat') return `${agent} (chat)`;
  if (connection.kind === 'local') return `${agent} (local)`;
  const via = [connection.client, connection.host].find(name => typeof name === 'string' && name.length > 0 && name !== agent);
  return `${agent} (${via ?? 'connector'})`;
}

/** A notebook's language as the confirm card names it (`meta.host`). */
const HOST_LABELS = Object.freeze({ python: 'Python (notebook)', r: 'R (notebook)' });

/**
 * Who asks, as a confirm card names it: an agent with its way in
 * (`agentLabel`), or a notebook by its language ("Python (notebook)"), which
 * is asked before it publishes (`dispatcher.js`).
 * @param {{origin?: string, agent?: string|null, connection?: object|null, host?: string|null}} meta
 */
export function actorLabel(meta) {
  if (meta?.origin === 'host') return HOST_LABELS[meta.host] ?? 'The notebook';
  return agentLabel(meta?.agent, meta?.connection);
}

/**
 * What a turn did outside the state that no undo takes back, counted
 * (`acts` of the actions: "1 vote published, 2 figures written"), or null.
 * @param {Array<{one: string, other: string, count: number}>} outside
 */
export function outsideText(outside) {
  if (!Array.isArray(outside) || outside.length === 0) return null;
  return outside.map(({ one, other, count }) => `${count} ${count === 1 ? one : other}`).join(', ');
}

/**
 * Count acts outside the state (`{one, other}` each) by their words.
 * @param {Array<{one: string, other: string}>} acts
 * @returns {Array<{one: string, other: string, count: number}>}
 */
export function countOutside(acts) {
  const counts = new Map();
  for (const act of acts) {
    const entry = counts.get(act.one) ?? { one: act.one, other: act.other, count: 0 };
    entry.count += 1;
    counts.set(act.one, entry);
  }
  return [...counts.values()];
}

/**
 * @param {{titleOf?: (type: string) => string, outsideOf?: (type: string, params: object, outcome: unknown) => ({one: string, other: string}|null)}} [options] -
 *   `titleOf`: an action's title by type (the catalogue); `outsideOf`: what an act outside the
 *   state that no undo takes back did, counted (`catalog.js` `outsideActOf`), else null
 */
export function createAgentActivity({ titleOf = type => type, outsideOf = () => null } = {}) {
  /** key → turn entry */
  const turns = new Map();
  let changed = 0;

  function entryFor(agent, turn, connection) {
    const key = turnKey(agent, turn, connection);
    let entry = turns.get(key);
    if (entry === undefined) {
      // A new turn of an agent replaces that agent's earlier one through the same connection that is over.
      const way = connectionKeyOf(connection);
      for (const [other, earlier] of turns) {
        if (earlier.agent === agent && earlier.way === way && earlier.running.size === 0 && earlier.attached === null) turns.delete(other);
      }
      entry = {
        key, agent, turn: turn ?? null, way, connection: connection?.kind ?? null, label: agentLabel(agent, connection),
        running: new Map(), steps: 0, outside: [], lastLabel: null, state: 'acting', attached: null, surface: null,
      };
      turns.set(key, entry);
    }
    return entry;
  }

  function settle(entry) {
    if (entry.running.size > 0 || entry.attached !== null) {
      if (entry.state !== 'stopped') entry.state = 'acting';
      return;
    }
    if (entry.state === 'acting') entry.state = 'done';
    // A turn that only read goes; one that acted outside the state stays, saying what stays done.
    if (entry.state === 'done' && entry.steps === 0 && entry.outside.length === 0) turns.delete(entry.key);
  }

  return Object.freeze({
    /**
     * A dispatcher event (`subscribe`); true when the lines change.
     * @param {{kind: string, type: string, meta?: object, step?: object|null}} event
     */
    onDispatch(event) {
      const meta = event.meta ?? {};
      // The history applying its own steps again (the steps after a deleted one) is no one acting now.
      if (meta.internal) return false;
      if (meta.origin !== 'agent') {
        // The person (or a notebook, a session) acted: the finished turns step aside.
        if (event.kind !== 'done' || event.step === null || event.step === undefined) return false;
        let gone = false;
        for (const [key, entry] of turns) {
          if (entry.running.size === 0 && entry.attached === null) { turns.delete(key); gone = true; }
        }
        if (gone) changed++;
        return gone;
      }
      const entry = entryFor(meta.agent, meta.turn, meta.connection ?? null);
      if (event.kind === 'start') {
        entry.running.set(meta, titleOf(event.type));
        if (entry.state !== 'stopped') entry.state = 'acting';
      } else if (event.kind === 'done' || event.kind === 'failed') {
        entry.running.delete(meta);
        if (event.kind === 'done' && event.step !== null && event.step !== undefined) {
          entry.steps += 1;
          entry.lastLabel = event.step.label;
        }
        const act = event.kind === 'done' && (event.step === null || event.step === undefined) ? outsideOf(event.type, event.params, event.outcome) : null;
        if (act !== null) entry.outside.push(act);
        settle(entry);
      } else {
        return false;
      }
      changed++;
      return true;
    },
    /**
     * A question of the agent turn of `meta` waits for the person (its
     * confirm card): the turn is acting, doing that action, until the
     * returned release (the card answered or withdrawn).
     * @param {{agent: string, turn?: string, connection?: {id: string, kind: string}|null}} meta
     * @param {string} type - the action asked about
     * @returns {() => void}
     */
    waitOnPerson(meta, type) {
      const entry = entryFor(meta.agent, meta.turn, meta.connection ?? null);
      const token = {};
      entry.running.set(token, titleOf(type));
      if (entry.state !== 'stopped') entry.state = 'acting';
      changed++;
      return () => {
        if (!entry.running.delete(token)) return;
        if (turns.get(entry.key) === entry) settle(entry);
        changed++;
      };
    },
    /**
     * An agent's own surface takes a turn as acting from now until `detach`
     * (`connection`: the way it came in, as its dispatches carry it;
     * `stop`: what its Stop also does; `shownElsewhere`: whether that
     * surface shows the turn itself now).
     * @param {{agent: string, turn: string, connection: {id: string, kind: string}|null, stop?: () => void, shownElsewhere?: () => boolean}} attachment
     */
    attach({ agent, turn, connection, stop = () => {}, shownElsewhere = () => false }) {
      const entry = entryFor(agent, turn, connection);
      entry.attached = { stop };
      // The surface shows its turn after it ends too (its Undo turn).
      entry.surface = shownElsewhere;
      entry.state = 'acting';
      changed++;
      return () => {
        if (turns.get(entry.key) !== entry || entry.attached === null) return;
        entry.attached = null;
        settle(entry);
        changed++;
      };
    },
    /** The turn `key` was stopped by the person; returns its attached stop, if any. */
    markStopped(key) {
      const entry = turns.get(key);
      if (entry === undefined) return null;
      entry.state = 'stopped';
      changed++;
      return entry.attached?.stop ?? null;
    },
    /** The turn `key` was undone. */
    markUndone(key) {
      const entry = turns.get(key);
      if (entry === undefined) return;
      entry.state = 'undone';
      changed++;
    },
    /** Hide the turn `key` (its line's ×); a turn still acting stays. */
    dismiss(key) {
      const entry = turns.get(key);
      if (entry === undefined || entry.running.size > 0 || entry.attached !== null) return;
      turns.delete(key);
      changed++;
    },
    /** Forget every turn that is over (another dataset is shown). */
    clearFinished() {
      for (const [key, entry] of turns) if (entry.running.size === 0 && entry.attached === null) turns.delete(key);
      changed++;
    },
    /**
     * The lines to show, oldest turn first: `{key, agent, label, connection,
     * turn, state, steps, outside, lastLabel, doing}` (`label`: the agent with
     * its way in, `agentLabel`; `connection`: that way's kind, `chat` or
     * `connector`, or null; `outside`: what it did outside the state that no
     * undo takes back, counted, `countOutside`; `doing`: the title of an
     * action running now).
     */
    lines() {
      const out = [];
      for (const entry of turns.values()) {
        if (entry.surface?.() === true) continue;
        const doing = entry.running.size > 0 ? [...entry.running.values()].at(-1) : null;
        out.push(Object.freeze({
          key: entry.key, agent: entry.agent, label: entry.label, connection: entry.connection, turn: entry.turn,
          state: entry.state, steps: entry.steps, outside: countOutside(entry.outside), lastLabel: entry.lastLabel, doing,
        }));
      }
      return out;
    },
    /** A counter that moves with every change (a redraw is due when it differs). */
    get version() { return changed; },
  });
}
