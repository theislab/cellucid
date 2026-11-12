/**
 * @fileoverview One agent tool call, run in this tab: the one way both ways
 * in (the chat bar and the relay of Claude's and ChatGPT's connector) turn a
 * call into an action.
 *
 * The tool is found in the catalog by its name (`mcp-tools.js`), the action
 * is dispatched as the agent (`origin: 'agent'`, its name, its turn, the
 * connection it came through, the call's signal), and the outcome becomes MCP content (`mcp-content.js`); a
 * refusal or a failure becomes a tool error with one sentence the model can
 * act on. So a call is checked, recorded, labeled and undone the same way
 * whoever made it.
 *
 * It is also the one place what an agent is sent of the data is decided:
 * while the dataset shown is set to names and summaries only
 * (`../data-scope.js`), a read of single cells' values or a picture, and a
 * value summary over groups an agent shaped by naming cells, are refused
 * before they run and again once they ran (the person may have turned the
 * switch on meanwhile), and what runs is sent without its single-cell
 * statistics and pictures (`data-guard.js`).
 *
 * @module app/agent/bridge/tool-call
 */

import { errorSentenceOf, toolErrorOf, toolResultOf } from './mcp-content.js';
import { quoteName } from '../../actions/targets/names.js';
import { shapedInputReads, shapedRefusal, summariesOnlyRefusal, unknownGroupsRefusal } from './data-guard.js';
import { outcomeAsJson } from '../../actions/outcome.js';
import { dataScopeNow } from '../data-scope.js';
import { ActionRefused } from '../../actions/dispatcher.js';

/**
 * @param {{
 *   actions: {dispatch: Function},
 *   tools: Map<string, object>,
 *   name: string,
 *   args: unknown,
 *   agent: string,
 *   turn: string,
 *   connection: {id: string, kind: 'chat'|'connector'|'local', client?: string|null, host?: string|null}|null,
 *   signal: AbortSignal|null,
 *   turnMeta?: {model?: string|null, conversation?: string|null, message?: string|null, turnLabel?: string|null},
 *   scopeOf?: () => {summariesOnly: boolean},
 * }} call - `tools` is `toolIndexOf(catalog)`; `connection`: the chat, connector
 *   or local connection the agent acts through (`meta.connection`: a
 *   permission granted for it holds there); `turnMeta`: what the history's
 *   turn record keeps of the turn (the model, the conversation, the message
 *   that acted, what was asked in a few words); `scopeOf`: what agents may be
 *   sent of the dataset now (left out: the dataset shown, `dataScopeNow`),
 *   asked before the call runs and again once it ran (the person may have
 *   turned the switch on meanwhile); `told`: Cellucid's notes said after the result, within its bound
 *   (an outside agent's connection told the person's settings: `agent-calls.js`)
 * @returns {Promise<{result: {content: object[], isError: boolean}, definition: object|null,
 *   step: {id: string, label: string}|null, summariesOnly?: boolean, code?: string}>} `summariesOnly`: the
 *   result was made under the dataset's switch (what the chat keeps with it, `data-guard.js`
 *   `earlierResultContent`); `code`: the refusal's code when the action refused (`ActionRefused`:
 *   `unavailable`, `no-target`, …), what the chat keeps of why beside the sentence the model reads
 */
export async function runToolCall({ actions, tools, name, args, agent, turn, connection = null, signal, turnMeta = {}, scopeOf = dataScopeNow, told = [] }) {
  const definition = tools.get(name) ?? null;
  if (definition === null) {
    return { result: toolErrorOf(`Cellucid has no tool ${quoteName(name)}.`, told), definition: null, step: null };
  }
  const params = args ?? {};
  const meta = {
    origin: 'agent', agent, turn, connection, signal,
    model: turnMeta.model ?? null, conversation: turnMeta.conversation ?? null,
    message: turnMeta.message ?? null, turnLabel: turnMeta.turnLabel ?? null,
  };
  const before = scopeOf();
  const refused = summariesOnlyRefusal(definition, before) ?? shapedRefusal(definition, params, before);
  if (refused !== null) return { result: toolErrorOf(refused, told), definition, step: null, summariesOnly: true };
  try {
    const { outcome, step, unrecorded = null } = await actions.dispatch(definition.type, params, meta);
    const made = step === null || step === undefined ? null : { id: step.id, label: step.label };
    // Switched on while it ran (or the dataset it ran on was): what it read is not sent.
    const after = scopeOf();
    const scope = { ...after, summariesOnly: before.summariesOnly === true || after.summariesOnly === true };
    let late = summariesOnlyRefusal(definition, scope) ?? shapedRefusal(definition, params, scope);
    if (late === null && scope.summariesOnly) {
      // The groups a summary is of, named by the reads that say them (an analysis's settings and pages).
      const inputs = [];
      for (const read of shapedInputReads(definition, params)) {
        try {
          inputs.push(outcomeAsJson((await actions.dispatch(read.type, read.params, meta)).outcome));
        } catch {
          // Not known what it was computed on: not sent.
          late = unknownGroupsRefusal(definition);
        }
      }
      late ??= shapedRefusal(definition, params, scope, inputs);
    }
    if (late !== null) return { result: toolErrorOf(late, told), definition, step: made, summariesOnly: true };
    return {
      result: await toolResultOf({ definition, outcome, step, unrecorded, summariesOnly: scope.summariesOnly, told }),
      definition,
      step: made,
      summariesOnly: scope.summariesOnly,
    };
  } catch (error) {
    return {
      result: toolErrorOf(errorSentenceOf(error, definition), told), definition, step: null, summariesOnly: before.summariesOnly === true,
      ...(error instanceof ActionRefused ? { code: error.code } : {}),
    };
  }
}
