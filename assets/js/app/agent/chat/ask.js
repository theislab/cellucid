/**
 * @fileoverview A question with choices: the chat bar's one tool of its own,
 * beside the catalog's (`bridge/mcp-tools.js`). The model asks the person
 * one short question with two to five choices; the chat shows the choices
 * as buttons above the message field, and a click sends the choice as the
 * person's next message (typing an answer works too).
 *
 * It is not an action: it changes nothing in Cellucid and records no step,
 * so it is not in the catalog, and a connector does not list it (Claude
 * and ChatGPT have their own ways to ask; the connector's instructions say
 * to ask in plain words with the choices listed). Its schema is in the
 * subset both providers take exactly (OpenAI's strict mode included).
 *
 * The call is answered at once ("the answer comes as the person's next
 * message") and the turn ends there: the conversation stays one a model
 * accepts, and the person's answer is an ordinary message of a new turn.
 *
 * @module app/agent/chat/ask
 */

/** The fewest and the most choices a question offers. */
export const ASK_CHOICES = Object.freeze({ min: 2, max: 5 });

/** The tool, as the chat's model is given it (an MCP tool, as the catalog's are). */
export const ASK_TOOL = Object.freeze({
  name: 'ask_person',
  title: 'Ask the person to choose',
  description: 'Ask the person one short question with 2 to 5 choices, shown as buttons in Cellucid; their answer comes as their next message, '
    + 'so your turn ends here. Use it when you need them to pick between a few concrete options (which field, which groups, which of two plans); '
    + 'first answer in your text what you can already (what you found, why you ask: a question the person asked is answered, not replaced by yours), '
    + 'then ask; do not repeat the question in your text.',
  inputSchema: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['question', 'choices']),
    properties: Object.freeze({
      question: Object.freeze({
        type: 'string',
        description: 'The question with what it rests on, in one or two short sentences, since the person may read nothing else of this turn: '
          + 'not "How would you like to proceed?" but "This dataset has no quality fields (no counts, no mitochondrial share): how should I filter?"',
      }),
      choices: Object.freeze({
        type: 'array',
        minItems: ASK_CHOICES.min,
        maxItems: ASK_CHOICES.max,
        items: Object.freeze({ type: 'string', description: 'One choice, a few words, as the person would answer.' }),
        description: 'The choices, each a few words; the person may also type another answer.',
      }),
    }),
  }),
  annotations: Object.freeze({
    title: 'Ask the person to choose',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  }),
});

/** What the model reads as the answer to its call. */
export const ASKED_TEXT = 'Asked. The person sees your question with its choices; their answer comes as their next message.';

/**
 * The question of a call's arguments, or why it is not one (a sentence the
 * model reads): one non-empty question, 2–5 distinct non-empty choices.
 * @param {unknown} args
 * @returns {{question: string, choices: string[]}|{problem: string}}
 */
export function askOf(args) {
  const question = typeof args?.question === 'string' ? args.question.trim() : '';
  if (question === '') return { problem: 'Give the question as one short sentence (question).' };
  const choices = Array.isArray(args?.choices)
    ? args.choices.filter(choice => typeof choice === 'string').map(choice => choice.trim()).filter(choice => choice !== '')
    : [];
  const distinct = [...new Set(choices)];
  if (distinct.length < ASK_CHOICES.min || distinct.length > ASK_CHOICES.max || distinct.length !== (args.choices?.length ?? 0)) {
    return { problem: `Give ${ASK_CHOICES.min} to ${ASK_CHOICES.max} different choices, each a few words (choices).` };
  }
  return { question, choices: distinct };
}

/**
 * The question still waiting for the person in a conversation: the last
 * turn's question asked (a valid call of `ask_person` answered "asked")
 * when no message of the person came after it; else null. A question of a
 * turn the conversation received (`conversation.js` `received`) was put to
 * the sender: its choices are not offered here (the person can still write).
 * @param {{messages: object[], received: string[]}} conversation
 * @returns {{turn: string, id: string, question: string, choices: string[]}|null}
 */
export function pendingQuestion(conversation) {
  const messages = conversation.messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user') return null;
    if (message.role !== 'assistant') continue;
    if (conversation.received.includes(message.turn)) return null;
    const calls = message.parts.filter(part => part.type === 'tool-call' && part.name === ASK_TOOL.name);
    for (const call of calls.reverse()) {
      const asked = askOf(call.args);
      if ('problem' in asked) continue;
      const answered = messages.slice(index + 1).find(other => other.role === 'tool')?.results.find(result => result.id === call.id);
      if (answered === undefined || answered.isError) continue;
      return { turn: message.turn, id: call.id, ...asked };
    }
  }
  return null;
}
