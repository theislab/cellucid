/**
 * One authorization waiting for the person: a Durable Object per connect
 * code (`approval:<code>`).
 *
 * The authorization page (in the browser that Claude or ChatGPT opened) and
 * the Cellucid tab that approves never talk to each other; they meet here,
 * by the code the page shows, and only in one browser:
 *
 * 1. `/create`: the authorize endpoint keeps the request (client, redirect
 *    URI, PKCE challenge, state, resource), the hash of a secret only the
 *    page knows, and the hash of the browser's approver cookie
 *    (`APPROVER_COOKIE`, set with the page).
 * 2. `/claim`: a tab (its pairing) asks who wants to connect, by a request
 *    its browser sends with the approver cookie (`oauth.js` `handleClaim`):
 *    a claim without the cookie of the browser that shows the page is
 *    refused (`other-browser`), so a code or link someone sent from their
 *    own browser cannot attach their agent here (RFC 8628 §5.4, the remote
 *    phishing of a device code). The first pairing to claim the code is the
 *    only one that can decide it.
 * 3. `/decide`: that tab allows or denies. Allowing makes a one-time
 *    authorization code bound to the pairing.
 * 4. `/wait`: the page, proving its secret, waits for the decision (long
 *    poll) and is sent on to the client's redirect URI, with the code or
 *    `access_denied`, and `iss` (RFC 9207). The page can also cancel.
 * 5. `/redeem`: the token endpoint exchanges the code once: the client id,
 *    redirect URI and resource must be the ones of the request and the PKCE
 *    verifier must hash to its challenge. Any attempt uses the code up.
 *
 * Everything is deleted when the request expires (an alarm), at the latest
 * `APPROVAL_SECONDS` plus `AUTHORIZATION_CODE_SECONDS` after it began.
 */

import { RELAY_BUNDLE } from './generated/bundle.js';
import { randomBase64Url, sameSecret, sha256Base64Url } from './encoding.js';

const CONNECT_CODE = RELAY_BUNDLE.protocol.connectCode;

/**
 * Whether `value` is a connect code as the relay issues them (exactly its
 * length, every symbol of its alphabet). Every way a code reaches an
 * approval object (the waiting page, the token endpoint, a tab's claim or
 * decision) is checked with this first, so no other text names one.
 */
export function isConnectCode(value) {
  return typeof value === 'string' && value.length === CONNECT_CODE.length
    && [...value].every(symbol => CONNECT_CODE.alphabet.includes(symbol));
}

/**
 * The cookie that says which browser shows an authorization's page. Set by
 * the relay with the page (`HttpOnly`, so no script reads it; `Secure` and
 * the `__Host-` prefix, so only the relay's own host sets or receives it,
 * never another subdomain; `SameSite=Strict`, so only a request from the
 * relay's own site, the Cellucid page's claim, carries it). On a local relay
 * (`http://localhost`, `http://127.0.0.1`) Chromium and Firefox keep a Secure
 * cookie too, since a loopback address counts as secure; Safari does not.
 */
export const APPROVER_COOKIE = '__Host-cellucid-approver';
/** An approver cookie's value: 32 random bytes as base64url. */
export const APPROVER_VALUE = /^[A-Za-z0-9_-]{43}$/;

/** How long a person has to approve a connection. */
export const APPROVAL_SECONDS = 10 * 60;
/** How long an authorization code may wait to be exchanged (OAuth asks for minutes at most). */
export const AUTHORIZATION_CODE_SECONDS = 5 * 60;
/** How long the page's long poll waits before it asks again (well inside proxies' idle limits). */
export const WAIT_POLL_MS = 25_000;
/** How long a declined request is kept, so its page still learns the answer. */
const DECLINED_KEEP_MS = 60_000;

const KEY = 'approval';
const FINAL = new Set(['approved', 'denied', 'expired']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function redirectWith(record, fields) {
  const url = new URL(record.redirectUri);
  for (const [name, value] of Object.entries(fields)) url.searchParams.append(name, value);
  if (record.state !== null) url.searchParams.append('state', record.state);
  url.searchParams.append('iss', record.issuer);
  return url.href;
}

export class RelayApproval {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /** @type {Set<() => void>} pages waiting for a change */
    this.waiters = new Set();
  }

  async record() {
    const record = await this.ctx.storage.get(KEY);
    if (record === undefined) return null;
    if ((record.status === 'waiting' || record.status === 'claimed') && Date.now() >= record.expiresAt) {
      record.status = 'expired';
      await this.ctx.storage.put(KEY, record);
      this.notify();
    }
    return record;
  }

  notify() {
    for (const wake of [...this.waiters]) wake();
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    const body = await request.json();
    switch (pathname) {
      case '/create': return this.create(body);
      case '/claim': return this.claim(body);
      case '/decide': return this.decide(body);
      case '/wait': return this.wait(body);
      case '/redeem': return this.redeem(body);
      default: return json({ error: 'unknown' }, 404);
    }
  }

  async create({ record }) {
    const existing = await this.record();
    if (existing !== null && !(existing.status === 'expired' || Date.now() >= existing.deleteAt)) {
      return json({ error: 'taken' }, 409);
    }
    await this.ctx.storage.deleteAll();
    const kept = { ...record, status: 'waiting', pairingId: null, redirect: null, grant: null, deleteAt: record.expiresAt };
    await this.ctx.storage.put(KEY, kept);
    await this.ctx.storage.setAlarm(kept.deleteAt);
    return json({ ok: true }, 201);
  }

  async claim({ pairingId, browserHash }) {
    const record = await this.record();
    if (record === null || record.status === 'expired') {
      return json({ code: 'unknown', message: 'This connect code is unknown or has expired. Start connecting again from Claude or ChatGPT.' }, 404);
    }
    if (typeof browserHash !== 'string' || !sameSecret(browserHash, record.browserHash)) {
      return json({
        code: 'other-browser',
        message: 'This connect code was started in another browser, so it cannot connect this one. Approve in the browser that shows the code, or start connecting again from Claude or ChatGPT in this browser.',
      }, 403);
    }
    if (record.pairingId !== null && record.pairingId !== pairingId) {
      return json({ code: 'claimed-elsewhere', message: 'Another browser is already approving this connect code.' }, 409);
    }
    if (FINAL.has(record.status)) {
      return json({ code: 'decided', message: 'This connection was already answered.' }, 409);
    }
    if (record.status === 'waiting') {
      record.status = 'claimed';
      record.pairingId = pairingId;
      await this.ctx.storage.put(KEY, record);
      this.notify();
    }
    return json({ client: record.client.display, expiresAt: record.expiresAt });
  }

  async decide({ pairingId, allow }) {
    const record = await this.record();
    if (record === null || record.status === 'expired') {
      return json({ code: 'unknown', message: 'This connect code is unknown or has expired.' }, 404);
    }
    if (FINAL.has(record.status)) {
      return json({ code: 'decided', message: 'This connection was answered already (allowed, declined or canceled on its page).' }, 409);
    }
    if (record.status !== 'claimed' || record.pairingId !== pairingId) {
      return json({ code: 'not-claimed', message: 'This browser did not claim this connect code.' }, 409);
    }
    const now = Date.now();
    if (allow === true) {
      const jti = randomBase64Url(32);
      record.status = 'approved';
      record.grant = { jti, expiresAt: now + AUTHORIZATION_CODE_SECONDS * 1000, redeemed: false };
      record.redirect = redirectWith(record, { code: `ac1.${record.code}.${jti}` });
      record.deleteAt = record.grant.expiresAt;
    } else {
      record.status = 'denied';
      record.redirect = redirectWith(record, { error: 'access_denied', error_description: 'The person declined in Cellucid' });
      record.deleteAt = now + DECLINED_KEEP_MS;
    }
    await this.ctx.storage.put(KEY, record);
    await this.ctx.storage.setAlarm(record.deleteAt);
    this.notify();
    return json({ status: record.status });
  }

  answerOf(record) {
    if (record === null) return { status: 'expired' };
    return FINAL.has(record.status) && record.status !== 'expired'
      ? { status: record.status, redirect: record.redirect }
      : { status: record.status };
  }

  async wait({ request, seen = null, cancel = false }) {
    let record = await this.record();
    if (record === null) return json({ status: 'expired' });
    if (!sameSecret(await sha256Base64Url(String(request)), record.requestHash)) {
      return json({ error: 'This page does not own this request.' }, 403);
    }
    if (cancel === true && (record.status === 'waiting' || record.status === 'claimed')) {
      record.status = 'denied';
      record.redirect = redirectWith(record, { error: 'access_denied', error_description: 'The person canceled the connection' });
      record.deleteAt = Date.now() + DECLINED_KEEP_MS;
      await this.ctx.storage.put(KEY, record);
      await this.ctx.storage.setAlarm(record.deleteAt);
      this.notify();
    }
    if (record.status === seen && !FINAL.has(record.status)) {
      await new Promise(resolve => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, Math.min(WAIT_POLL_MS, Math.max(0, record.expiresAt - Date.now())));
        this.waiters.add(wake);
      });
      record = await this.record();
    }
    return json(this.answerOf(record));
  }

  async redeem({ jti, clientId, redirectUri, verifier, resource }) {
    const refuse = (error, description) => json({ ok: false, error, description });
    const record = await this.record();
    if (record === null || record.status !== 'approved' || record.grant === null || !sameSecret(String(jti), record.grant.jti)) {
      return refuse('invalid_grant', 'The authorization code is unknown or was not approved');
    }
    if (record.grant.redeemed) return refuse('invalid_grant', 'The authorization code was used already');
    record.grant.redeemed = true;
    await this.ctx.storage.put(KEY, record);
    if (Date.now() >= record.grant.expiresAt) return refuse('invalid_grant', 'The authorization code has expired');
    if (clientId !== record.client.id) return refuse('invalid_grant', 'The authorization code was issued to another client');
    if (redirectUri !== record.redirectUri) return refuse('invalid_grant', 'redirect_uri is not the one of the authorization request');
    if (resource !== null && resource !== record.resource) return refuse('invalid_target', 'resource is not the one of the authorization request');
    if (!sameSecret(await sha256Base64Url(String(verifier)), record.challenge)) {
      return refuse('invalid_grant', 'The PKCE code_verifier does not match the code_challenge');
    }
    return json({
      ok: true,
      grant: {
        pairingId: record.pairingId,
        clientId: record.client.id,
        agent: record.client.display.agent,
        clientName: record.client.display.name,
        clientHost: record.client.display.host,
        known: record.client.display.known,
        scope: record.scope,
        resource: record.resource,
      },
    });
  }

  async alarm() {
    const record = await this.ctx.storage.get(KEY);
    if (record !== undefined && Date.now() < record.deleteAt) {
      await this.ctx.storage.setAlarm(record.deleteAt);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.notify();
  }
}
