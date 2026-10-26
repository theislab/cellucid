/**
 * The public identifiers this site uses to open files on Google Drive and
 * OneDrive. None of them is a secret: each is sent in plain sight by every
 * page that uses it, and each is restricted at its provider to this site's
 * origins. No client secret exists anywhere; none is ever needed.
 *
 * Registered by the site's owner with Google (project `cellucid`) and
 * Microsoft Entra (app "Cellucid", publisher domain cellucid.com); see
 * `docs/google-microsoft-oauth-setup.md`. A value left empty makes what
 * needs it say "not configured on this site yet"; everything else works.
 * Public Figshare items need nothing here.
 *
 * @module data/sources/provider-config
 */

export const PROVIDER_CONFIG = Object.freeze({
  google: Object.freeze({
    /** Google Cloud OAuth client ID (Web application), `….apps.googleusercontent.com`. */
    clientId: '209459713812-l2nm220ahvies0dto43b6v6korefveeq.apps.googleusercontent.com',
    /** Google Cloud API key, restricted to this site's referrers and to the Drive and Picker APIs. */
    apiKey: 'AIzaSyDjn-KpARFFJD1159GvcO7nuSbiiuCrF00',
    /** Google Cloud project number: the Picker's app id. */
    projectNumber: '209459713812',
    /**
     * The origins registered with Google, in both places: the API key's
     * website restriction (as `<origin>/*`) and the client ID's authorized
     * JavaScript origins. Google matches an origin exactly, port included, so
     * a local Cellucid reads Drive files only on port 8765, the default of
     * `cellucid serve`; elsewhere the app says where Drive works.
     */
    registeredOrigins: Object.freeze([
      'https://www.cellucid.com',
      'http://127.0.0.1:8765',
      'http://localhost:8765',
    ]),
  }),
  microsoft: Object.freeze({
    /** Microsoft Entra application (client) ID of the single-page application. */
    clientId: '18aa2a4e-6431-4ef0-858d-fb6fdcab528e',
    /** Personal and work or school accounts. */
    authority: 'common',
  }),
});
