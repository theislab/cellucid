/**
 * @fileoverview Publishes the release version and the exact deployed web
 * build identity in the footer. The version is the release line the web app
 * shares with the Python and R packages; the build id names this deployment.
 * @module ui/core/build-version
 */

const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function readOneMeta(documentOwner, name, label) {
  const elements = documentOwner.querySelectorAll(`meta[name="${name}"]`);
  if (elements.length !== 1) {
    throw new TypeError(`Web build publication requires exactly one ${label} meta element.`);
  }
  return elements[0].getAttribute('content');
}

export function publishWebBuildVersion(documentOwner = document) {
  if (
    documentOwner === null
    || typeof documentOwner !== 'object'
    || typeof documentOwner.querySelectorAll !== 'function'
    || typeof documentOwner.getElementById !== 'function'
  ) {
    throw new TypeError('Web build publication requires the current document owner.');
  }

  const version = readOneMeta(documentOwner, 'cellucid-version', 'version');
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new TypeError('Web build publication requires one release version.');
  }
  const buildId = readOneMeta(documentOwner, 'cellucid-web-build-id', 'build-id');
  if (typeof buildId !== 'string' || !BUILD_ID_PATTERN.test(buildId)) {
    throw new TypeError('Web build publication requires one canonical build id.');
  }

  const versionOutput = documentOwner.getElementById('web-version');
  const output = documentOwner.getElementById('web-build-version');
  if (versionOutput === null || output === null) {
    throw new Error('Web build publication requires the footer version and build elements.');
  }
  versionOutput.textContent = version;
  versionOutput.title = `Cellucid ${version}`;
  output.textContent = buildId;
  output.title = `Website build ${buildId}`;
  return buildId;
}
