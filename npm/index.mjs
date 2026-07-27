/**
 * Cellucid — name reservation package.
 *
 * Cellucid is a browser-first, GPU-accelerated workspace for exploring large
 * single-cell datasets. It is not consumed as a JavaScript library today: the
 * application is hosted at https://www.cellucid.com and driven from Python
 * (`pip install cellucid`) or R (`install.packages("cellucid")`).
 *
 * This module exports only pointers to the real entry points, so that
 * `import ... from "cellucid"` resolves instead of throwing. If a local-serving
 * CLI ships later, it will replace this file.
 */

/** Hosted application. */
export const app = "https://www.cellucid.com";

/** Full documentation: installation, data preparation, UI reference. */
export const docs = "https://cellucid.readthedocs.io/en/latest/";

/** Source repository for the web application. */
export const repository = "https://github.com/theislab/cellucid";

/** Python distribution on PyPI. */
export const python = "https://pypi.org/project/cellucid/";

/** R distribution. */
export const r = "https://github.com/theislab/cellucid-r";

export default { app, docs, repository, python, r };
