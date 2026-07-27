/**
 * @fileoverview Publishes the exact deployed web build identity in the footer.
 * @module ui/core/build-version
 */

const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function publishWebBuildVersion(documentOwner = document) {
  if (
    documentOwner === null
    || typeof documentOwner !== 'object'
    || typeof documentOwner.querySelectorAll !== 'function'
    || typeof documentOwner.getElementById !== 'function'
  ) {
    throw new TypeError('Web build publication requires the current document owner.');
  }

  const buildMeta = documentOwner.querySelectorAll(
    'meta[name="cellucid-web-build-id"]'
  );
  if (buildMeta.length !== 1) {
    throw new TypeError('Web build publication requires exactly one build-id meta element.');
  }
  const buildId = buildMeta[0].getAttribute('content');
  if (typeof buildId !== 'string' || !BUILD_ID_PATTERN.test(buildId)) {
    throw new TypeError('Web build publication requires one canonical build id.');
  }

  const output = documentOwner.getElementById('web-build-version');
  if (output === null) {
    throw new Error('Web build publication requires the footer build element.');
  }
  output.textContent = buildId;
  output.title = `Website build ${buildId}`;
  return buildId;
}
