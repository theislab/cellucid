/**
 * @fileoverview What the Connect panel says, from the relay client's state
 * (`bridge/relay-client.js`): the one status line, each connection's row,
 * and the approval's sentences. Pure: no DOM, no clock of its own.
 *
 * @module app/agent/connect/model
 */

import { formatAgo } from '../../ui/modules/state/model.js';
import { formatRemaining } from '../../../utils/format-units.js';
import { lowerFirst } from '../../../utils/text-case.js';

/** The agents connected, each named once, in the order the list gives them. */
function agentNames(connections) {
  const names = [];
  for (const connection of connections) {
    if (!names.includes(connection.agent)) names.push(connection.agent);
  }
  return names;
}

function joinNames(names) {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} agents`;
}

/**
 * The panel's status line: what the connection is now, in a few words that
 * fit the sidebar on one line (`detail`, the whole sentence, is its title
 * and what the info tip's live line says).
 *
 * @param {{state: string, error: string|null, retryAt: number|null}} status - `relay-client.js` `status()`
 * @param {{paired: boolean, connections: ReadonlyArray<{agent: string}>|null, now: number}} context -
 *   `paired`: this browser keeps a tab secret; `connections`: the list, null before it was read
 * @returns {{text: string, detail: string, tone: 'muted'|'success'|'warning'|null}}
 */
export function describeConnectStatus(status, { paired, connections, now }) {
  switch (status.state) {
    case 'unavailable':
      return {
        text: 'Unavailable: site data is blocked.',
        detail: 'This browser keeps no data for Cellucid (private browsing, or site data blocked), so it cannot stay connected to Claude or ChatGPT.',
        tone: 'warning',
      };
    case 'refused':
      return {
        text: 'Reload the page to reconnect.',
        detail: 'This page and the Cellucid relay were updated separately. Reload the page to reconnect.',
        tone: 'warning',
      };
    case 'connecting':
      return { text: 'Connecting…', detail: 'Connecting to the Cellucid relay.', tone: null };
    case 'retrying': {
      const wait = status.retryAt === null ? null : Math.max(0, status.retryAt - now);
      const when = wait === null || wait < 1000 ? 'now' : `in ${formatRemaining(wait)}`;
      return {
        text: `Offline · retrying ${when}`,
        detail: `${status.error ?? 'The Cellucid relay cannot be reached.'} Trying again ${when}; it reconnects by itself when the network is back.`,
        tone: 'warning',
      };
    }
    case 'connected': {
      if (connections === null) return { text: 'Connected', detail: 'Connected to the Cellucid relay.', tone: 'success' };
      const names = agentNames(connections);
      return names.length === 0
        ? { text: 'Ready · no agent yet', detail: 'Connected to the Cellucid relay; no agent is connected through this browser yet.', tone: 'muted' }
        : { text: `${joinNames(names)} connected`, detail: `${joinNames(names)} can work in this browser's Cellucid tabs.`, tone: 'success' };
    }
    default:
      return paired
        ? { text: 'Off', detail: 'Not connected to the Cellucid relay.', tone: 'muted' }
        : {
          text: 'Not connected yet',
          detail: 'Not connected. Add the connector address to Claude or ChatGPT, then approve the connection here.',
          tone: 'muted',
        };
  }
}

/**
 * An app as the person sees it named: `agent` (Claude or ChatGPT when their
 * host vouches for them, else the app's host, else an app on this computer:
 * the relay's `clientDisplay`), and the name it gives itself, `name`: beside
 * a vouched name in brackets ("Claude (Claude Code)"), beside any other only
 * in quotes, as what it calls itself, never as its name (an app at evil.com
 * may call itself "Claude").
 * @param {string} agent
 * @param {string|null} name
 * @param {boolean} known
 * @param {'title'|'sentence'} form - `sentence`: set off by commas inside a sentence
 */
export function appName(agent, name, known, form = 'title') {
  if (typeof name !== 'string' || name.length === 0 || name === agent) return agent;
  if (known) return `${agent} (${name})`;
  return form === 'sentence' ? `${agent}, which calls itself “${name}”,` : `${agent} (calls itself “${name}”)`;
}

/**
 * One connection's row in Manage…: who, through which host, since when and
 * when last used.
 *
 * @param {{agent: string, client: string|null, host: string|null, known: boolean, createdAt: number, lastUsedAt: number}} connection
 * @param {number} now
 * @returns {{title: string, meta: string}}
 */
export function describeConnection(connection, now) {
  const by = connection.host === null ? 'an app on this computer' : connection.host;
  return {
    title: appName(connection.agent, connection.client, connection.known === true),
    meta: `${by} · connected ${formatAgo(connection.createdAt, now).short} · used ${formatAgo(connection.lastUsedAt, now).short}`,
  };
}

/**
 * What the approval dialog says: who asks, where the answer goes, and the
 * warnings the person needs: an app neither Claude nor ChatGPT; a code
 * followed from a link (the relay lets only the browser that shows the
 * waiting page claim a code, so a link someone sent from their own browser
 * attaches nothing; a waiting page someone sent could still be theirs, so
 * the person allows only what they started); a code typed.
 *
 * @param {{display: string, via: 'link'|'typed', client: {agent: string, name: string|null, host: string|null,
 *   redirectHost: string|null, loopback: boolean, known: boolean}}} approval - `relay-client.js` `claim()`
 * @returns {{title: string, who: string, where: string, warnings: string[]}}
 */
export function describeApproval(approval) {
  const { client } = approval;
  const who = client.known ? `${client.agent} (${client.host})` : appName(client.agent, client.name, false, 'sentence');
  const warnings = [];
  if (!client.known) warnings.push('Allow only if you started connecting Cellucid from this app yourself, just now.');
  else if (approval.via === 'link') warnings.push(`Allow only if you asked ${client.agent} to connect just now, never for a link someone sent you.`);
  if (approval.via === 'typed') warnings.push('Allow only a code you see on your own screen now, never one someone sent you.');
  // An app on this computer that no host vouches for is named as such, mid-sentence in lower case.
  const named = !client.known && client.host === null ? lowerFirst(client.agent) : client.agent;
  return {
    title: `Connect ${named}?`,
    who: `${who} asks to work in Cellucid in this browser: read the open dataset and act in it. Every step it takes is kept in the history and can be undone.`,
    where: client.loopback
      ? `The answer goes to an app on this computer (${client.redirectHost}).`
      : `The answer goes to ${client.redirectHost}.`,
    warnings,
  };
}
