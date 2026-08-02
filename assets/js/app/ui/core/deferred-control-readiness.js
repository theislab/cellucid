/**
 * @module app/ui/core/deferred-control-readiness
 *
 * The renderer and benchmark controls, and why they start out inert.
 *
 * Every one of them is static markup in `index.html`, so the browser paints
 * them and offers them the moment the page renders — seconds before the
 * bootstrap reaches their listener, and on a slow link much longer. A click in
 * that window is discarded without a request, a message or a record.
 *
 * The benchmark controls are wired at the very end of `main.js`, past the
 * initial dataset publication. The renderer controls are wired earlier, by
 * `initRenderControls` inside `initUI`, because a restored session publishes
 * them by dispatching their own events and cannot wait for the bootstrap tail
 * (CEL-0129) — but `initUI` still runs several awaits deep, so they too are
 * offered long before they do anything.
 *
 * For the renderer toggles the loss would be worse than silence:
 * `render-controls.js` seeds its rollback baseline — `acceptedShaderQuality`,
 * `acceptedFrustumEnabled`, `acceptedLodEnabled`, `acceptedForcedLodValue` —
 * from the markup defaults, which are the values the renderer is constructed
 * with. A value the user changed while nothing was listening would be read as
 * one the renderer already accepted, and the next rejected change would roll
 * back to it.
 *
 * `#hp-antialias` is here for the same reason with a different ending: it is
 * seeded from the viewer's own context attribute when its listener attaches, so
 * a click made before that is not merely lost — it is visibly undone.
 *
 * So a control is not offered until the listener that acts on it exists. This
 * is the rule `index.html` already applies to the data-source controls, which
 * ship `disabled` for exactly this reason; see the comment above
 * `#data-source-status` and `publishDataSourceReadiness` in `ui-coordinator.js`.
 *
 * `<details id="benchmark-section">` is deliberately absent from this list. It
 * is a disclosure rather than a control, it cannot be disabled, and opening it
 * is harmless — `main.js` reconciles its open state at the moment it attaches
 * the `toggle` listener, so a summary click during startup loads the panel
 * instead of revealing an empty one.
 */

/**
 * Controls the bootstrap wires only after it has blocked on something.
 *
 * Kept next to the retirement itself so the contract tests can hold this list
 * against `index.html` and against the wiring sites that own each control.
 */
export const DEFERRED_CONTROL_IDS = Object.freeze([
  'benchmark-report-btn',
  'benchmark-run',
  'bottleneck-analyze-btn',
  'hp-antialias',
  'hp-frustum-culling',
  'hp-lod-enabled',
  'hp-lod-force',
  'hp-shader-quality',
]);

/** Control groups that exist in more than one copy. */
export const DEFERRED_CONTROL_SELECTORS = Object.freeze(['.benchmark-preset']);

/**
 * Take the late-wired controls out of service until their listeners exist.
 *
 * Only controls this call actually disabled are admitted again, so a control
 * held disabled for some other reason keeps its own state.
 *
 * @param {Document} documentOwner
 * @returns {() => void} Admits the controls; call it where the listeners attach
 */
export function retireDeferredControls(documentOwner) {
  const retired = [];

  for (const id of DEFERRED_CONTROL_IDS) {
    const control = documentOwner.getElementById(id);
    if (control === null) {
      throw new Error(
        `The renderer and benchmark controls require #${id}.`
      );
    }
    if (control.disabled) continue;
    control.disabled = true;
    retired.push(control);
  }

  for (const selector of DEFERRED_CONTROL_SELECTORS) {
    const controls = documentOwner.querySelectorAll(selector);
    if (controls.length === 0) {
      throw new Error(
        `The renderer and benchmark controls require ${selector}.`
      );
    }
    for (const control of controls) {
      if (control.disabled) continue;
      control.disabled = true;
      retired.push(control);
    }
  }

  let admitted = false;
  return function admitDeferredControls() {
    if (admitted) return;
    admitted = true;
    for (const control of retired) control.disabled = false;
  };
}
