/**
 * The page's content security policy (`index.html`) blocks nothing the app
 * itself loads, and allows Google's scripts only by their exact paths.
 *
 * A dataset is opened and shown (its modules, reader and render workers,
 * blob URLs, fonts, images, the sample catalog), then every script the app
 * may load from Google is requested as the app requests it — the analytics
 * tag (`www.googletagmanager.com/gtag/js`, and `/gtag/destination`, which it
 * may load), Google's sign-in (`accounts.google.com/gsi/client`) and the
 * file picker's loader (`apis.google.com/js/api.js`) with a module it loads
 * (`apis.google.com/_/scs/…`) — each answered by a stub, so nothing reaches
 * Google. None of these may raise a policy violation. Scripts anyone can
 * publish on the same hosts (a Tag Manager container, another path) must be
 * refused, and so must a form submission.
 *
 * The dataset is Blosc-compressed, so opening it compiles the WebAssembly
 * decoders (`assets/wasm/codecs.wasm`) in the reader and decode workers
 * under this policy (`'wasm-unsafe-eval'`); JavaScript evaluation stays
 * refused.
 */
import { expect, test } from './helpers/test.mjs';
import { APP_ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const ALLOWED = [
  'https://www.googletagmanager.com/gtag/js?id=G-K4774ZWGEQ',
  'https://www.googletagmanager.com/gtag/destination?id=G-K4774ZWGEQ',
  'https://accounts.google.com/gsi/client',
  'https://apis.google.com/js/api.js',
  'https://apis.google.com/_/scs/abc-static/_/js/k=gapi.lb.en/m=picker/cb=gapi.loaded_0',
];
const REFUSED = [
  'https://www.googletagmanager.com/gtm.js?id=GTM-ATTACKER',
  'https://apis.google.com/js/plusone.js',
  'https://accounts.google.com/o/oauth2/jsonp',
];

test('the policy blocks nothing the app loads, and Google scripts only by their exact paths', async ({ page, context }) => {
  const loaded = [];
  await context.route(/https:\/\/(www\.googletagmanager\.com|accounts\.google\.com|apis\.google\.com)\//, route => {
    loaded.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* stub */' });
  });
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', event => {
      window.__violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
  const url = new URL('/', APP_ORIGIN);
  url.searchParams.set('sampleCatalog', `${APP_ORIGIN}/tests/browser/fixtures/demo-catalog/`);
  url.searchParams.set('dataset', 'synthetic-cell-types-2d');
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
  await expect(page.locator('#dataset-name')).toHaveText('Synthetic cell-type islands — 2D');
  expect(await page.evaluate(() => window.__violations)).toEqual([]);

  const outcomes = await page.evaluate(async ([allowed, refused]) => {
    const load = src => new Promise(resolve => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve('loaded');
      script.onerror = () => resolve('refused');
      document.head.appendChild(script);
    });
    return {
      allowed: await Promise.all(allowed.map(load)),
      refused: await Promise.all(refused.map(load)),
    };
  }, [ALLOWED, REFUSED]);
  expect(outcomes.allowed).toEqual(ALLOWED.map(() => 'loaded'));
  expect(outcomes.refused).toEqual(REFUSED.map(() => 'refused'));
  expect(loaded.sort()).toEqual([...ALLOWED].sort());

  const violations = await page.evaluate(() => window.__violations);
  expect(violations.map(violation => violation.directive).every(directive => directive.startsWith('script-src'))).toBe(true);
  expect(violations.length).toBe(REFUSED.length);

  // No page submits a form: the submission is refused (Firefox throws on
  // it, every engine reports the violation or the throw) and the page stays.
  const submission = await page.evaluate(() => {
    const form = document.createElement('form');
    form.action = 'https://collector.example/';
    form.method = 'post';
    document.body.appendChild(form);
    try {
      form.submit();
      return 'submitted';
    } catch {
      return 'threw';
    }
  });
  await expect.poll(async () => submission === 'threw' || await page.evaluate(() => (
    window.__violations.some(violation => violation.directive === 'form-action')
  ))).toBe(true);
  expect(new URL(page.url()).origin).toBe(APP_ORIGIN);

  // WebAssembly compiles under the policy; JavaScript evaluation does not.
  const evaluation = await page.evaluate(async () => {
    const before = window.__violations.length;
    const response = await fetch('/assets/wasm/codecs.wasm');
    const module = await WebAssembly.compile(await response.arrayBuffer());
    let javascript = 'evaluated';
    try {
      new Function('return 1')();
    } catch {
      javascript = 'refused';
    }
    return { exports: WebAssembly.Module.exports(module).length, javascript, before };
  });
  expect(evaluation.exports).toBeGreaterThan(0);
  expect(evaluation.javascript).toBe('refused');
  await expect.poll(() => page.evaluate(before => (
    window.__violations.slice(before).some(violation => violation.directive.startsWith('script-src'))
  ), evaluation.before)).toBe(true);
});
