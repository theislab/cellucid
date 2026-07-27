#!/usr/bin/env node
/**
 * Placeholder CLI for the reserved `cellucid` npm name.
 *
 * Prints where the real entry points live. If a local-serving CLI ships later
 * (`npx cellucid` starting the web app on localhost for offline or firewalled
 * environments), it replaces this file.
 */

import { app, docs, python, r, repository } from "../index.mjs";

const message = `
Cellucid — see every cell. Query any gene. Fly through millions.

This npm package is a name reservation. Cellucid is not published as a
JavaScript library yet; there is nothing to run here.

  Use the app        ${app}
  Documentation      ${docs}

  Python             pip install cellucid
  R                  install.packages("cellucid")

  PyPI               ${python}
  R source           ${r}
  Web app source     ${repository}

Want an offline or self-hosted build (\`npx cellucid\` serving the app on
localhost)? That is the use case this package name is held for — open an
issue at ${repository}/issues
`;

process.stdout.write(`${message.trim()}\n`);
