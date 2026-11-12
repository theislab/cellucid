/**
 * @fileoverview The chat bar's choices this browser remembers for the
 * person: the provider, the model of each provider, the effort chosen for
 * each model, the person's own instructions for agents, the token budget of
 * a chat (none by default), how long Claude keeps the cached prompt (5
 * minutes by default, or an hour), and whether the chat was open. A convenience only (`localStorage`, `cellucid:agent-chat`): a browser
 * that keeps no site data starts from the defaults each visit. API keys are
 * not kept here (`keys.js`).
 *
 * @module app/agent/chat/preferences
 */

import { webStorage } from '../../../utils/web-storage.js';

export const PREFERENCES_STORAGE_KEY = 'cellucid:agent-chat';

const EMPTY = Object.freeze({
  provider: null, models: Object.freeze({}), efforts: Object.freeze({}), instructions: '', budget: null, cache: '5m', open: false,
});

/** How long a provider that offers it keeps the cached prompt: five minutes (the default) or an hour. */
export const CACHE_LENGTHS = Object.freeze(['5m', '1h']);

/** The key of a model's effort (`provider:model`). */
export function effortKey(providerId, modelId) {
  return `${providerId}:${modelId}`;
}

/** The remembered choices (the defaults when none are kept or they cannot be read). */
export function readChatPreferences({ storage } = {}) {
  try {
    const store = storage ?? webStorage('localStorage');
    const value = JSON.parse(store?.getItem(PREFERENCES_STORAGE_KEY) ?? 'null');
    if (value === null || typeof value !== 'object') return EMPTY;
    const strings = record => (record !== null && typeof record === 'object' && !Array.isArray(record)
      ? Object.fromEntries(Object.entries(record).filter(([, choice]) => typeof choice === 'string'))
      : {});
    return Object.freeze({
      provider: typeof value.provider === 'string' ? value.provider : null,
      models: Object.freeze(strings(value.models)),
      efforts: Object.freeze(strings(value.efforts)),
      instructions: typeof value.instructions === 'string' ? value.instructions : '',
      budget: Number.isSafeInteger(value.budget) && value.budget > 0 ? value.budget : null,
      cache: CACHE_LENGTHS.includes(value.cache) ? value.cache : '5m',
      open: value.open === true,
    });
  } catch {
    return EMPTY;
  }
}

/** Remember `changes` on top of what is kept; nothing happens when the browser keeps no site data. */
export function writeChatPreferences(changes, { storage } = {}) {
  const current = readChatPreferences({ storage });
  const next = {
    provider: changes.provider ?? current.provider,
    models: { ...current.models, ...(changes.models ?? {}) },
    // An effort of null is the model's own default: not kept.
    efforts: Object.fromEntries(Object.entries({ ...current.efforts, ...(changes.efforts ?? {}) }).filter(([, effort]) => typeof effort === 'string')),
    instructions: changes.instructions ?? current.instructions,
    budget: changes.budget === undefined ? current.budget : changes.budget,
    cache: changes.cache ?? current.cache,
    open: changes.open ?? current.open,
  };
  try {
    (storage ?? webStorage('localStorage'))?.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A browser that keeps no site data: the choice lasts for this page.
  }
  return next;
}
