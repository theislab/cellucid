/**
 * The page a person sees when Claude or ChatGPT asks to connect: who asks,
 * the connect code, "Open Cellucid to approve" (a link to the Cellucid page
 * with `#cellucid_connect=<code>`), and a live wait that sends the browser on
 * as soon as the person allowed or denied in Cellucid. The response sets the
 * browser's approver cookie (`approval.js` `APPROVER_COOKIE`, in `oauth.js`):
 * only a Cellucid page of this browser can claim the code. Its script and style
 * are served by the relay itself (`script-src 'self'`), and it can be framed
 * by nobody.
 */

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function pageResponse(html, status) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  });
}

function shell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/oauth/assets/authorize.css">
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * The waiting page.
 * @param {{code: string, display: string, request: string, appOrigin: string, client: object, expiresInMinutes: number}} page
 */
export function approvalPage({ code, display, request, appOrigin, client, expiresInMinutes }) {
  // Claude and ChatGPT with the host that vouches for them; any other app by its host (or as an
  // app on this computer), with the name it gives itself only in quotes, as what it calls itself.
  const selfNamed = client.name !== null && client.name !== client.agent
    ? `, which calls itself <q>${escapeHtml(client.name)}</q>,` : '';
  const who = client.known
    ? `${escapeHtml(client.agent)} <span class="host">(${escapeHtml(client.host)})</span>`
    : `${escapeHtml(client.agent)}${selfNamed}`;
  const local = client.loopback
    ? `<p class="note">The app asking runs on this computer: the answer goes to <strong>${escapeHtml(client.redirectHost)}</strong>.</p>`
    : `<p class="note">The answer goes to <strong>${escapeHtml(client.redirectHost)}</strong>.</p>`;
  const unknown = client.known ? '' : '<p class="warn">Approve only if you started connecting Cellucid from this app yourself, just now.</p>';
  // An app on this computer that no host vouches for is named as such, mid-sentence in lower case.
  const named = !client.known && client.host === null ? `${client.agent.charAt(0).toLowerCase()}${client.agent.slice(1)}` : client.agent;
  const link = `${appOrigin}/#cellucid_connect=${encodeURIComponent(display)}`;
  return pageResponse(shell('Connect to Cellucid', `<main data-code="${escapeHtml(code)}" data-request="${escapeHtml(request)}">
<h1>Connect ${escapeHtml(named)} to Cellucid</h1>
<p>${who} asks to work in the Cellucid tab you approve it from: read the open dataset and act in it. Every step it takes is kept in that tab's history and can be undone there.</p>
${local}
${unknown}
<p class="code" aria-label="Connect code">${escapeHtml(display)}</p>
<p><a class="primary" href="${escapeHtml(link)}" target="_blank" rel="noopener">Open Cellucid to approve</a></p>
<p class="small">Approve in this browser: the link opens Cellucid here, or type the code under Connect in a Cellucid tab of this browser. Another browser or device cannot take it.</p>
<p id="status" role="status" aria-live="polite">Waiting for your answer in Cellucid…</p>
<p><button id="cancel" type="button">Cancel</button></p>
<p class="small">The code expires in ${escapeHtml(expiresInMinutes)} minutes.</p>
</main>
<script src="/oauth/assets/authorize.js" defer></script>`), 200);
}

/**
 * A page that says why the request cannot go on. With `answer` (the error
 * redirect to an app the relay cannot vouch for, and that app's host) the
 * person may take the error back to the app by a link; nothing is sent
 * there by itself.
 * @param {string} message
 * @param {number} status
 * @param {{href: string, host: string}|null} [answer]
 */
export function failurePage(message, status, answer = null) {
  const next = answer === null
    ? '<p class="small">Close this window and try connecting again from the app that asked.</p>'
    : `<p><a href="${escapeHtml(answer.href)}" rel="noreferrer">Return to ${escapeHtml(answer.host)}</a></p>`;
  return pageResponse(shell('Cellucid cannot connect', `<main>
<h1>Cellucid cannot connect</h1>
<p>${escapeHtml(message)}</p>
${next}
</main>`), status);
}

export const AUTHORIZE_CSS = `:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #5f6368; --bg: #ffffff; --accent: #2457d6; --line: #d0d4da; --warn: #8a4b00; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --muted: #a0a4ab; --bg: #16171a; --accent: #7aa2ff; --line: #3a3d44; --warn: #f0b35a; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; }
.host, .small, .note { color: var(--muted); }
.small { font-size: 0.875rem; }
.warn { color: var(--warn); }
.code { font: 600 2rem/1.2 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.12em; margin: 1.5rem 0; }
a.primary { display: inline-block; padding: 0.6rem 1rem; border-radius: 0.5rem; background: var(--accent); color: var(--bg); text-decoration: none; font-weight: 600; }
a.primary:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
button { font: inherit; padding: 0.4rem 0.9rem; border-radius: 0.5rem; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

export const AUTHORIZE_JS = `(() => {
  const main = document.querySelector('main[data-code]');
  if (main === null) return;
  const status = document.getElementById('status');
  const cancelButton = document.getElementById('cancel');
  const body = extra => JSON.stringify({ code: main.dataset.code, request: main.dataset.request, ...extra });
  let seen = 'waiting';
  let done = false;
  let failures = 0;
  const say = text => { status.textContent = text; };
  function handle(answer) {
    if (answer.status === 'approved' || answer.status === 'denied') {
      done = true;
      cancelButton.disabled = true;
      say(answer.status === 'approved' ? 'Approved in Cellucid. Returning to the app…' : 'Not connected. Returning to the app…');
      window.location.replace(answer.redirect);
      return;
    }
    if (answer.status === 'expired') {
      done = true;
      cancelButton.disabled = true;
      say('This request expired. Start connecting again from the app that asked.');
      return;
    }
    if (answer.status === 'claimed') say('Cellucid shows the request. Allow or deny it there.');
    seen = answer.status;
  }
  async function ask(extra) {
    const response = await fetch('/oauth/authorize/wait', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: body(extra),
    });
    if (!response.ok) throw new Error('relay ' + response.status);
    return response.json();
  }
  async function loop() {
    while (!done) {
      try {
        handle(await ask({ seen }));
        failures = 0;
      } catch {
        failures += 1;
        say('The connection to Cellucid\\'s relay was lost. Trying again…');
        await new Promise(resolve => setTimeout(resolve, Math.min(30000, 1000 * 2 ** failures)));
      }
    }
  }
  cancelButton.addEventListener('click', async () => {
    cancelButton.disabled = true;
    try { handle(await ask({ cancel: true })); } catch { cancelButton.disabled = false; }
  });
  loop();
})();
`;

/** The page's script or style. */
export function authorizeAsset(name) {
  const asset = name === 'authorize.js'
    ? { body: AUTHORIZE_JS, type: 'text/javascript; charset=utf-8' }
    : name === 'authorize.css' ? { body: AUTHORIZE_CSS, type: 'text/css; charset=utf-8' } : null;
  if (asset === null) return null;
  return new Response(asset.body, {
    status: 200,
    headers: {
      'Content-Type': asset.type,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
