/**
 * The view card (MCP Apps, `ui://cellucid/view`): what Claude and ChatGPT
 * draw in the chat beside a picture of the person's view or a dataset
 * opened (`VIEW_APP.tools` of the protocol bundle).
 *
 * A picture is a result, not data: the card shows the image the tab drew
 * (`view_picture`), and for a dataset opened it asks the tab for one
 * itself (a tool call the host passes to the relay, as the model's are).
 * It says which step of the person's history the picture is after
 * (`_meta['cellucid/view'].step`). Refresh draws the view as it is now;
 * Open in Cellucid opens the dataset's
 * public link (`_meta['cellucid/view'].link`, what Share gives), or
 * Cellucid itself when the dataset has none. No dataset bytes reach the
 * card or the relay: it needs no network of its own, so its resource
 * declares no domain and the host's default policy (nothing but itself)
 * holds.
 *
 * One HTML document, its script and style inline (the MCP Apps default
 * policy allows inline script and style, and nothing from elsewhere).
 * It speaks the MCP Apps protocol over `postMessage` (specification
 * 2026-01-26): `ui/initialize`, then `ui/notifications/initialized`; it
 * hears the tool's input and result, a cancellation, the host's theme and
 * style variables, and teardown; it says its size as it changes.
 */

import { RELAY_BUNDLE } from './generated/bundle.js';

/** The MCP Apps protocol version the card speaks. */
export const VIEW_APP_PROTOCOL = '2026-01-26';

const VIEW = RELAY_BUNDLE.protocol.viewApp;

const STYLE = `:root { color-scheme: light dark; font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  --cv-fg: var(--color-text-primary, CanvasText); --cv-muted: var(--color-text-secondary, GrayText);
  --cv-line: var(--color-border-secondary, color-mix(in srgb, CanvasText 18%, transparent)); }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
html, body { margin: 0; background: transparent; color: var(--cv-fg); }
main { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
header { display: flex; align-items: center; gap: 8px; min-width: 0; }
h1 { flex: 1; min-width: 0; margin: 0; font-size: var(--font-text-md-size, 14px); line-height: var(--font-text-md-line-height, 1.4);
  font-weight: var(--font-weight-semibold, 600); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
button { flex: none; font: inherit; font-size: var(--font-text-sm-size, 13px); padding: 4px 10px; border-radius: var(--border-radius-sm, 4px);
  border: var(--border-width-regular, 1px) solid var(--cv-line); background: transparent; color: var(--cv-fg); cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible { outline: 2px solid var(--color-ring-primary, Highlight); outline-offset: 2px; }
.status { margin: 0; font-size: var(--font-text-sm-size, 13px); line-height: var(--font-text-sm-line-height, 1.4); color: var(--cv-muted); }
canvas { display: block; width: 100%; height: auto; border: var(--border-width-regular, 1px) solid var(--cv-line);
  border-radius: var(--border-radius-md, 6px); }
canvas[hidden], .status:empty { display: none; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }`;

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** The card's script: the constants it needs, then the client of the MCP Apps protocol. */
function script() {
  const constants = JSON.stringify({
    protocol: VIEW_APP_PROTOCOL,
    meta: VIEW.meta,
    pictureTool: VIEW.pictureTool,
    data: RELAY_BUNDLE.protocol.resultData,
    appOrigin: RELAY_BUNDLE.appOrigin,
    version: RELAY_BUNDLE.appVersion,
  });
  return `(() => {
  const C = ${constants};
  const $ = id => document.getElementById(id);
  const title = $('title');
  const status = $('status');
  const notes = $('notes');
  const canvas = $('picture');
  const refreshButton = $('refresh');
  const openButton = $('open');
  const waiting = new Map();
  let nextId = 1;
  let link = null;
  let dataset = null;
  let step = null;
  let ready = false;
  let drawing = false;

  const send = message => window.parent.postMessage(message, '*');
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
  function request(method, params) {
    const id = nextId++;
    send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  }
  const say = text => { status.textContent = text; sizeChanged(); };

  function sizeChanged() {
    if (!ready) return;
    const root = document.documentElement;
    notify('ui/notifications/size-changed', { width: Math.ceil(root.scrollWidth), height: Math.ceil(root.scrollHeight) });
  }

  function applyContext(context) {
    if (context === null || typeof context !== 'object') return;
    if (context.theme === 'light' || context.theme === 'dark') document.documentElement.dataset.theme = context.theme;
    const variables = context.styles && context.styles.variables;
    if (variables && typeof variables === 'object') {
      for (const [name, value] of Object.entries(variables)) {
        if (/^--[a-z0-9-]+$/.test(name) && typeof value === 'string') document.documentElement.style.setProperty(name, value);
      }
    }
  }

  function textOf(result) {
    const item = Array.isArray(result && result.content) ? result.content.find(each => each && each.type === 'text') : null;
    return item ? String(item.text) : '';
  }

  function learn(result) {
    const meta = result && result._meta && result._meta[C.meta];
    if (!meta || typeof meta !== 'object') return;
    dataset = typeof meta.dataset === 'string' && meta.dataset ? meta.dataset : null;
    link = typeof meta.link === 'string' && /^https:\\/\\//.test(meta.link) ? meta.link : null;
    step = meta.step && typeof meta.step.label === 'string' && typeof meta.step.id === 'string' ? meta.step : null;
    title.textContent = dataset || 'Cellucid';
    openButton.textContent = link ? 'Open in Cellucid' : 'Open Cellucid';
  }

  async function draw(image) {
    const binary = atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mimeType }));
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    canvas.hidden = false;
    canvas.setAttribute('aria-label', 'The Cellucid view' + (dataset ? ' of ' + dataset : ''));
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    say('The view at ' + time + (step ? ', after step ' + step.id + ': ' + step.label : '') + '. Refresh draws it as it is now.');
  }

  async function show(result) {
    learn(result);
    if (result && result.isError) {
      say(textOf(result) || 'Cellucid could not answer.');
      return;
    }
    const image = Array.isArray(result && result.content) ? result.content.find(each => each && each.type === 'image') : null;
    let parsed = null;
    // The result's JSON is its data, between the data tags (Cellucid's own sentences follow them).
    const text = textOf(result);
    const end = text.indexOf(C.data.close);
    try { parsed = text.startsWith(C.data.open) && end !== -1 ? JSON.parse(text.slice(C.data.open.length, end)) : null; } catch { parsed = null; }
    notes.textContent = parsed && Array.isArray(parsed.notes) && parsed.notes.length > 0 ? parsed.notes.join(' ') : '';
    if (image) {
      await draw(image);
      return;
    }
    const leftOut = textOf(result).match(/\\[Cellucid: [^\\]]*\\]/);
    if (leftOut) {
      say(leftOut[0].slice(1, -1));
      return;
    }
    // A dataset opened: draw its view.
    await refresh();
  }

  async function refresh() {
    if (drawing) return;
    drawing = true;
    refreshButton.disabled = true;
    say('Drawing the view…');
    const width = Math.max(240, Math.round(document.querySelector('main').clientWidth));
    const height = Math.round(width * 0.62);
    try {
      const result = await request('tools/call', { name: C.pictureTool, arguments: { width, height, legend: true } });
      learn(result);
      if (result && result.isError) say(textOf(result) || 'The view could not be drawn.');
      else {
        const image = (result.content || []).find(each => each && each.type === 'image');
        if (image) await draw(image);
        else say('The view came back without a picture.');
      }
    } catch (error) {
      say('The view could not be drawn: ' + (error && error.message ? error.message : 'the chat refused the call') + '.');
    } finally {
      drawing = false;
      refreshButton.disabled = false;
    }
  }

  function answer(message, result) {
    if (message.id !== undefined && message.id !== null) send({ jsonrpc: '2.0', id: message.id, result });
  }

  function handle(message) {
    switch (message.method) {
      case 'ui/notifications/tool-result':
        show(message.params).catch(error => say('The result could not be shown: ' + error.message));
        return;
      case 'ui/notifications/tool-cancelled':
        say('The call was cancelled.');
        return;
      case 'ui/notifications/host-context-changed':
        applyContext(message.params);
        return;
      case 'ui/resource-teardown':
      case 'ping':
        answer(message, {});
        return;
      case 'ui/notifications/tool-input':
      case 'ui/notifications/tool-input-partial':
        return;
      default:
        if (message.id !== undefined && message.id !== null) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found: ' + message.method } });
        }
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (typeof message.method === 'string') {
      handle(message);
      return;
    }
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.error) entry.reject(new Error(String(message.error.message || 'refused')));
    else entry.resolve(message.result);
  });

  refreshButton.addEventListener('click', () => { refresh(); });
  openButton.addEventListener('click', () => {
    request('ui/open-link', { url: link || C.appOrigin }).catch(() => say('The chat did not open the link: ' + (link || C.appOrigin)));
  });
  new ResizeObserver(sizeChanged).observe(document.documentElement);

  request('ui/initialize', {
    appInfo: { name: 'Cellucid view', version: C.version },
    appCapabilities: { availableDisplayModes: ['inline'] },
    protocolVersion: C.protocol,
  }).then(result => {
    applyContext(result && result.hostContext);
    ready = true;
    notify('ui/notifications/initialized', {});
    sizeChanged();
  }, () => say('This chat cannot show the Cellucid view; the answer above says what Cellucid did.'));
})();`;
}

/** The card's HTML document. */
export function viewAppHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Cellucid view</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<h1 id="title">${escapeHtml('Cellucid')}</h1>
<button type="button" id="refresh">Refresh</button>
<button type="button" id="open">Open Cellucid</button>
</header>
<canvas id="picture" role="img" aria-label="The Cellucid view" hidden></canvas>
<p id="status" class="status" role="status" aria-live="polite">Waiting for Cellucid…</p>
<p id="notes" class="status"></p>
</main>
<script>${script()}</script>
</body>
</html>
`;
}

/** The resource as `resources/list` names it. */
export function viewAppListing() {
  return {
    uri: VIEW.uri,
    name: 'cellucid-view',
    title: 'Cellucid view',
    description: 'A picture of the person\'s Cellucid view, with Refresh and Open in Cellucid.',
    mimeType: VIEW.mimeType,
  };
}

/**
 * The resource as `resources/read` answers it: the HTML, and the card's
 * wishes to the host (a border; no network, no frames: no domain declared).
 */
export function viewAppContents() {
  return {
    uri: VIEW.uri,
    mimeType: VIEW.mimeType,
    text: viewAppHtml(),
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
  };
}
