/**
 * @fileoverview The model providers the chat bar offers on this page.
 *
 * Each provider is one module behind the contract of `contract.js`; adding
 * or replacing one (another company's API, a sign-in once one is offered)
 * is a module here and its line below, and nothing else changes. The
 * scripted model (`scripted.js`) is offered only on a development host and
 * only while a script is installed, for the browser specs.
 *
 * @module app/agent/providers
 */

import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';
import { createScriptedProvider } from './scripted.js';
import { isLocalDevHost } from '../../utils/local-dev.js';

/** Where a spec installs the scripted model's script (`scripted.js`). */
export const AGENT_SCRIPT_GLOBAL = '__CELLUCID_AGENT_SCRIPT__';

/**
 * The providers of this page, in the order the settings list them.
 * @param {{win?: object|null}} [options]
 */
export function providersForPage({ win = globalThis.window ?? null } = {}) {
  const providers = [createAnthropicProvider(), createOpenAIProvider()];
  const script = win?.[AGENT_SCRIPT_GLOBAL];
  if (script !== undefined && script !== null && isLocalDevHost()) providers.push(createScriptedProvider(script));
  return Object.freeze(providers);
}
