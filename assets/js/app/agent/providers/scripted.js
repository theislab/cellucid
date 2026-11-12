/**
 * @fileoverview A model that follows a script: the chat bar's provider in
 * the browser specs, so every run of the chat (streaming, tool calls, a
 * Stop mid-turn, a refusal, a failure and its retry) is the same without a
 * key or a network.
 *
 * The script is `{agent?, reply(messages, tools, {effort})}`: `reply` is given the
 * provider-neutral messages so far (`contract.js`) and the MCP tools, and
 * returns (or resolves) what the model says next:
 *
 * - `text`: the reply's words, streamed in `chunks` pieces (default 1),
 *   `delayMs` apart (default 0), each wait stopped by the call's signal;
 * - `calls`: `[{name, args, note?}]`, tool calls after the text (ids
 *   `call-<n>`, counted per provider, so a run is the same every time); a
 *   call's `note` is streamed before it as `progress`, as a model that
 *   writes notes between its calls does (`providers/anthropic.js`);
 * - `stop`: `refusal` or `max-tokens` instead of the reason the calls imply,
 *   with `detail` for a refusal;
 * - `error`: `{kind, message, retryAfterMs?}`, a failure of the call instead
 *   (`ProviderError`), to drive a retry or a refusal of the key; with
 *   `usage`, the call reports those tokens before it fails (a provider that
 *   began to answer);
 * - `usage`: `{input, output}`, the tokens the call reports (by default
 *   about one per four characters of what it was sent and wrote);
 * - `hold`: a promise the call waits on, with its signal, after its text
 *   and before its calls (the model still answering until the test lets it
 *   go: a Stop mid-answer at a moment the test chooses).
 *
 * `reply` is also given `{effort}`, the effort the person chose (null: the
 * model's default).
 *
 * The page offers it only on a development host, and only once a script is
 * installed as `window.__CELLUCID_AGENT_SCRIPT__` (`providers/index.js`).
 *
 * @module app/agent/providers/scripted
 */

import { ProviderError, checkProvider } from './contract.js';
import { awaitWithSignal, throwIfAborted } from '../../../utils/abort.js';

function wait(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  let timer;
  return awaitWithSignal(new Promise(resolve => { timer = setTimeout(resolve, ms); }), signal)
    .finally(() => clearTimeout(timer));
}

function pieces(text, count) {
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, count)));
  const out = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

/**
 * @param {{agent?: string, reply: (messages: object[], tools: object[], options: {effort: string|null}) => (object|Promise<object>)}} script
 */
export function createScriptedProvider(script) {
  if (typeof script?.reply !== 'function') throw new TypeError('A scripted model needs reply(messages, tools)');
  let nextCall = 1;
  return checkProvider({
    id: 'scripted',
    label: 'Scripted model',
    agent: typeof script.agent === 'string' && script.agent !== '' ? script.agent : 'Scripted agent',
    needsKey: false,
    defaultModel: 'scripted',
    async models() {
      return [Object.freeze({ id: 'scripted', label: 'Scripted', contextTokens: null, outputTokens: null, images: true, efforts: Object.freeze(['low', 'high']) })];
    },
    async *stream({ messages, tools, signal = null, effort = null }) {
      throwIfAborted(signal);
      const step = await awaitWithSignal(Promise.resolve(script.reply(structuredClone(messages), tools, { effort })), signal);
      if (step?.error) {
        if (step.usage) yield { type: 'usage', input: step.usage.input ?? 0, output: step.usage.output ?? 0, cacheRead: 0, cacheWrite: 0 };
        throw new ProviderError(step.error.kind, step.error.message, { retryAfterMs: step.error.retryAfterMs ?? null });
      }
      const text = typeof step?.text === 'string' ? step.text : '';
      for (const piece of pieces(text, step?.chunks ?? 1)) {
        await wait(step?.delayMs ?? 0, signal);
        yield { type: 'text', text: piece };
      }
      if (step?.hold) await awaitWithSignal(step.hold, signal);
      const calls = Array.isArray(step?.calls) ? step.calls : [];
      for (const call of calls) {
        await wait(step?.delayMs ?? 0, signal);
        if (typeof call.note === 'string' && call.note !== '') yield { type: 'progress', text: call.note };
        yield { type: 'tool-call', id: `call-${nextCall++}`, name: call.name, args: call.args ?? {} };
      }
      const input = step?.usage?.input ?? Math.ceil(JSON.stringify(messages).length / 4);
      const output = step?.usage?.output ?? Math.ceil(text.length / 4);
      yield { type: 'usage', input, output, cacheRead: 0, cacheWrite: 0 };
      const reason = step?.stop ?? (calls.length > 0 ? 'tool-use' : 'end');
      yield { type: 'stop', reason, ...(step?.detail ? { detail: step.detail } : {}) };
    },
  });
}
