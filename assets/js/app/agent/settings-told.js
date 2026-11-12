/**
 * @fileoverview What an agent is told of the person's settings, in one set
 * of words for every way in: the permissions (what runs, what is asked, what
 * is refused), the dataset's data switch ("names and summaries only") and
 * what the History settings leave out of the history.
 *
 * The tool list never says them (`bridge/mcp-tools.js`: it stays the same
 * while they change, so a client's cached prompt and the model's reasoning
 * stay valid). They are told instead: to the chat bar's model with the
 * person's message (`chat/index.js`), to an agent outside the tab (the
 * connector, a local `cellucid mcp`) after the first tool result of its
 * connection and after any result once they changed
 * (`bridge/agent-calls.js`).
 *
 * @module app/agent/settings-told
 */

import { permissionsForAgent } from './presence/permissions.js';
import { notRecordedSentences } from './bridge/mcp-tools.js';

/** The dataset's data switch, in the words an agent is told. */
export function dataScopeSentence(summariesOnly) {
  return summariesOnly
    ? 'This dataset is set to names and summaries only: reads of single cells\' values and pictures of the plot are refused; work from names, counts and summaries.'
    : 'Reads of this dataset are not limited (values of cells and pictures of the plot included).';
}

/**
 * The person's settings as an agent is told them.
 * @param {{permissions: {kinds: Record<string, 'ask'|'allow'|'deny'>}|null, summariesOnly: boolean, offDomains: string[]}} settings -
 *   `permissions`: the kinds as they hold for this agent (the person's
 *   settings with what they allowed for its chat or connection), or null
 *   when no presence decides (then nothing is said of them); `offDomains`:
 *   `history-settings.js` `offDomainsOf`
 * @returns {string}
 */
export function settingsTold({ permissions, summariesOnly, offDomains }) {
  return [
    ...(permissions === null ? [] : [`Permissions: ${permissionsForAgent(permissions)}`]),
    dataScopeSentence(summariesOnly),
    ...notRecordedSentences(offDomains),
  ].join(' ');
}
