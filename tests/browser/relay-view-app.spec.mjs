/**
 * The view card (`relay/view-app.js`, MCP Apps `ui://cellucid/view`) in a
 * host played by the spec: a page that frames the card's HTML in a
 * sandboxed iframe and speaks the host's side of the MCP Apps protocol over
 * `postMessage`, as Claude and ChatGPT do.
 *
 * - The card asks `ui/initialize` with its app info and protocol version,
 *   takes the host's theme and style variables, then says
 *   `ui/notifications/initialized`; nothing is sent to it before that.
 * - A picture's result (`view_picture`) is drawn; its notes are shown; the
 *   dataset's name heads the card, Open in Cellucid opens its link.
 * - A dataset opened (`dataset_open`, no picture) is drawn by asking the
 *   host for `view_picture` at the card's width; Refresh asks again.
 * - A picture left out (larger than a chat takes) says so; a tool error is
 *   said; teardown is answered.
 * - The card reaches nothing but its host: no request leaves the frame.
 *
 * Every result's text is the tab's: its JSON between the data tags
 * (`resultDataText`), then Cellucid's own sentences.
 */
import { expect, test } from './helpers/test.mjs';
import { viewAppHtml } from '../../relay/view-app.js';
import { resultDataText } from '../../assets/js/app/agent/bridge/relay-protocol.js';

/** A result's text as the tab writes it (`mcp-content.js`): its JSON as data. */
const dataText = value => resultDataText(JSON.stringify(value));
const EMPTY = dataText({});

/** A 64 × 48 PNG of one colour, as base64. */
async function pngOf(page, color) {
  return page.evaluate(async fill => {
    const canvas = new OffscreenCanvas(64, 48);
    const context = canvas.getContext('2d');
    context.fillStyle = fill;
    context.fillRect(0, 0, 64, 48);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  }, color);
}

const HOST = `<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body>
<iframe id="card" sandbox="allow-scripts" style="width:600px;height:500px;border:0"></iframe>
<script>
  window.hostLog = [];
  window.hostInitialized = false;
  window.hostCalls = [];
  window.hostAnswers = {};
  const frame = document.getElementById('card');
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow) return;
    const message = event.data;
    window.hostLog.push(message);
    const reply = result => frame.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*');
    switch (message.method) {
      case 'ui/initialize':
        reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'spec-host', version: '1' }, hostCapabilities: { openLinks: {}, serverTools: {} },
          hostContext: { theme: 'dark', styles: { variables: { '--color-text-primary': 'rgb(1, 2, 3)' } }, displayMode: 'inline' } });
        return;
      case 'ui/notifications/initialized':
        window.hostInitialized = true;
        return;
      case 'tools/call':
        window.hostCalls.push(message.params);
        reply(window.hostAnswers[message.params.name]);
        return;
      case 'ui/open-link':
        reply({});
        return;
      default:
    }
  });
  window.send = message => frame.contentWindow.postMessage(message, '*');
</script></body></html>`;

/** The canvas's colour at its centre, from inside the card. */
function centreColour(page) {
  return page.frameLocator('#card').locator('#picture').evaluate(canvas => {
    if (canvas.hidden || canvas.width === 0) return null;
    const [r, g, b] = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
    return [r, g, b];
  });
}

test('the card speaks MCP Apps: initialize, then a picture drawn, Refresh and Open in Cellucid through its host', async ({ page }) => {
  const outside = [];
  page.on('request', request => {
    if (!request.url().startsWith('about:') && !request.url().startsWith('data:')) outside.push(request.url());
  });
  await page.setContent(HOST);
  const red = await pngOf(page, '#ff0000');
  const blue = await pngOf(page, '#0000ff');
  const meta = { 'cellucid/view': { dataset: 'Pancreas', link: 'https://www.cellucid.com/?dataset=pancreas', step: { id: 's3', label: 'Coloured by cell_type' }, version: '0.9.7' } };
  await page.evaluate(html => { document.getElementById('card').srcdoc = html; }, viewAppHtml());
  await expect.poll(() => page.evaluate(() => window.hostInitialized)).toBe(true);
  const initialize = await page.evaluate(() => window.hostLog.find(message => message.method === 'ui/initialize'));
  expect(initialize.params).toEqual({
    appInfo: { name: 'Cellucid view', version: expect.any(String) },
    appCapabilities: { availableDisplayModes: ['inline'] },
    protocolVersion: '2026-01-26',
  });
  const card = page.frameLocator('#card');
  // The host's theme and its style variables.
  await expect(card.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(card.locator('h1')).toHaveCSS('color', 'rgb(1, 2, 3)');

  // A picture's result is drawn, headed with its dataset.
  await page.evaluate(([png, metadata, text]) => window.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {
    content: [{ type: 'text', text },
      { type: 'image', data: png, mimeType: 'image/png' }],
    isError: false, _meta: metadata,
  } }), [red, meta, dataText({ png: { image: 1, mimeType: 'image/png', bytes: 100 }, width: 64, height: 48, notes: ['The grid is not drawn.'] })]);
  await expect.poll(() => centreColour(page)).toEqual([255, 0, 0]);
  await expect(card.locator('#title')).toHaveText('Pancreas');
  await expect(card.locator('#notes')).toHaveText('The grid is not drawn.');
  await expect(card.locator('#open')).toHaveText('Open in Cellucid');
  await expect(card.locator('#status')).toHaveText(/^The view at .+, after step s3: Coloured by cell_type\. Refresh draws it as it is now\.$/);
  // It says its size to the host.
  await expect.poll(() => page.evaluate(() => window.hostLog.filter(message => message.method === 'ui/notifications/size-changed').length)).toBeGreaterThan(0);

  // Refresh asks the host for the view at the card's width.
  await page.evaluate(([png, metadata, text]) => {
    window.hostAnswers.view_picture = { content: [{ type: 'text', text }, { type: 'image', data: png, mimeType: 'image/png' }], isError: false, _meta: metadata };
  }, [blue, meta, EMPTY]);
  await card.locator('#refresh').click();
  await expect.poll(() => centreColour(page)).toEqual([0, 0, 255]);
  const [refresh] = await page.evaluate(() => window.hostCalls);
  expect(refresh.name).toBe('view_picture');
  expect(refresh.arguments.legend).toBe(true);
  expect(refresh.arguments.width).toBeGreaterThanOrEqual(240);
  expect(refresh.arguments.height).toBe(Math.round(refresh.arguments.width * 0.62));

  await card.locator('#open').click();
  await expect.poll(() => page.evaluate(() => window.hostLog.find(message => message.method === 'ui/open-link')?.params)).toEqual({ url: 'https://www.cellucid.com/?dataset=pancreas' });

  // Teardown is answered.
  await page.evaluate(() => window.send({ jsonrpc: '2.0', id: 99, method: 'ui/resource-teardown', params: { reason: 'done' } }));
  await expect.poll(() => page.evaluate(() => window.hostLog.some(message => message.id === 99 && message.result !== undefined))).toBe(true);
  expect(outside).toEqual([]);
});

test('a dataset opened is drawn by asking for its view; a picture left out and an error are said', async ({ page }) => {
  await page.setContent(HOST);
  const green = await pngOf(page, '#00ff00');
  await page.evaluate(([png, text]) => {
    window.hostAnswers.view_picture = { content: [{ type: 'text', text }, { type: 'image', data: png, mimeType: 'image/png' }], isError: false };
  }, [green, EMPTY]);
  await page.evaluate(html => { document.getElementById('card').srcdoc = html; }, viewAppHtml());
  await expect.poll(() => page.evaluate(() => window.hostInitialized)).toBe(true);
  const card = page.frameLocator('#card');
  // dataset_open answers with text and metadata, no picture: the card asks for one.
  await page.evaluate(text => window.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {
    content: [{ type: 'text', text }],
    isError: false, _meta: { 'cellucid/view': { dataset: 'Lung', link: null, version: '0.9.7' } },
  } }), dataText({ name: 'Lung', kind: 'sample', cells: 10, total_cells: 10, genes: 5, saved_states: 0, already_open: false }));
  await expect.poll(() => centreColour(page)).toEqual([0, 255, 0]);
  await expect(card.locator('#title')).toHaveText('Lung');
  // No public link: the button opens Cellucid itself.
  await expect(card.locator('#open')).toHaveText('Open Cellucid');
  expect((await page.evaluate(() => window.hostCalls)).map(call => call.name)).toEqual(['view_picture']);

  await page.evaluate(text => window.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {
    content: [{ type: 'text', text }],
    isError: false,
  } }), `${dataText({ png: 'x' })}\n[Cellucid: picture 1 is 9,000 × 600 pixels, more than a chat takes (8,000 a side), so it is left out. Ask for a smaller one.]`);
  await expect(card.locator('#status')).toHaveText('Cellucid: picture 1 is 9,000 × 600 pixels, more than a chat takes (8,000 a side), so it is left out. Ask for a smaller one.');
  await page.evaluate(() => window.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {
    content: [{ type: 'text', text: 'No Cellucid tab is connected to this chat.' }], isError: true,
  } }));
  await expect(card.locator('#status')).toHaveText('No Cellucid tab is connected to this chat.');
});
