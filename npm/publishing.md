# Publishing `cellucid` (npm)

**To release the npm package, publish a GitHub Release `vX.Y.Z` in
`theislab/cellucid`; the workflow `.github/workflows/npm-publish.yml`
("Publish to npm") publishes it to [npmjs.com](https://www.npmjs.com/package/cellucid).**
Nothing else publishes it: pushing a tag does nothing, and there is no token
and no publishing from a laptop.

The order across the Python, R and npm packages and the shared checklist are
in [Releasing Cellucid](https://docs.cellucid.com/en/latest/contributing/releasing.html).

---

## Table of Contents

1. [What you are publishing, and why](#what-you-are-publishing-and-why)
2. [One-time setup: the trusted publisher](#one-time-setup-the-trusted-publisher)
3. [Releasing a version](#releasing-a-version)
4. [What the workflow checks](#what-the-workflow-checks)
5. [Re-running and failures](#re-running-and-failures)
6. [Reference](#reference)

---

## What you are publishing, and why

This directory is **not** the Cellucid web app. It is a small placeholder
package that holds the name `cellucid` on npm.

| | |
|---|---|
| Package name | `cellucid` |
| Version | The Cellucid release version (`npm/package.json`, moved by every version bump with the rest) |
| Contents | `package.json`, `README.md`, `LICENSE`, `index.mjs`, `bin/cellucid.mjs` |
| Size | A few kilobytes |
| What it does | `npx cellucid` prints where the real app and docs live |

**Why not publish the actual app?** The web app is a static site with no
importable entry point, nothing an npm user could `import` or call. The name
is worth holding anyway, for one concrete future use: a `npx cellucid` command
that serves the app on `localhost` for users behind firewalls that block
`www.cellucid.com`.

**Why the same version?** The web app, the Python package and the R package
share one version and are released together. Releasing this placeholder under
that version keeps one habit for all of them and keeps the package visibly
maintained. Every version holds the same pointers.

**Is reserving a name allowed?** Yes, when the name matches a real project you
actually ship, which is the case here (`cellucid` on PyPI, `cellucid` for R,
`www.cellucid.com`, `github.com/theislab/cellucid`). npm's
[dispute policy](https://docs.npmjs.com/policies/disputes) covers names held by
people with no claim to them. Keep the README honest about the package being a
placeholder; that is what makes the difference.

`npm/package.json` carries `"config": { "cellucid-version-marker":
"CELLUCID_VERSION" }` on the line after its version: JSON has no comments, so
that field is how `grep -rn CELLUCID_VERSION` and
`cellucid-python/scripts/sweep_versions.py` find the version a bump has to
move.

---

## One-time setup: the trusted publisher

The workflow authenticates with npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OpenID
Connect from GitHub Actions): npm accepts a publish from exactly this
repository's `npm-publish.yml`, and no token exists anywhere. Do this once, as
an owner of the `cellucid` package on npm:

1. Sign in at **https://www.npmjs.com** and open the package:
   **https://www.npmjs.com/package/cellucid** → **Settings**.
2. In **Trusted Publisher**, under **Select your publisher**, click
   **GitHub Actions**.
3. Fill in the fields exactly (they are case-sensitive):

   | Field | Value |
   |---|---|
   | Organization or user | `theislab` |
   | Repository | `cellucid` |
   | Workflow filename | `npm-publish.yml` (the file name only, not the path) |
   | Environment name | leave empty |

4. Save it. npm does not check the fields when they are saved; a mismatch
   shows only when the workflow publishes.
5. Recommended, after the first successful publish: **Settings** →
   **Publishing access** → **Require two-factor authentication and disallow
   tokens** → **Update Package Settings**. Trusted publishing is unaffected;
   token-based publishing is refused.

**Timing:** npm requires a newly created trusted-publisher configuration to
complete its first successful publish **within 2 days**, or it expires and
has to be deleted and created again. Set it up shortly before publishing the
first release that should reach npm.

---

## Releasing a version

1. The version bump moved `npm/package.json` with every other declaration
   (`python cellucid-python/scripts/sweep_versions.py` ends with
   `VERDICT: OK`), and CI is green on `main`.
2. In `theislab/cellucid`: **Releases** → **Draft a new release** →
   **Choose a tag** → type `vX.Y.Z` (the version) → **Create new tag**, target
   `main`.
3. Title `Cellucid X.Y.Z`; the notes can link the version's changelog.
4. Leave **Set as a pre-release** unticked for an `X.Y.Z` version, and press
   **Publish release**.
5. Watch **Actions** → **Publish to npm**. When it is green,
   `npm view cellucid version` prints the new version, and the package page
   shows a provenance badge linking the run.

---

## What the workflow checks

`npm-publish.yml` runs on `release: published` only, with
`permissions: id-token: write, contents: read`. Before publishing it:

- installs Node 24 with `registry-url: https://registry.npmjs.org`, and
  requires Node 22.14 or later and npm 11.5.1 or later (trusted publishing's
  minimum), installing npm 11 when the bundled one is older;
- refuses a draft release, and a release whose pre-release mark does not
  match the version (an `X.Y.Z` version is never published from a release
  marked pre-release; an `X.Y.Z-rc.1` version must be marked and is published
  under the `next` dist-tag);
- requires the release's tag to equal `v` plus `npm/package.json`'s version;
- requires the tagged commit to be on `origin/main`;
- requires `npm pack --dry-run` to contain exactly `package.json` and the
  tracked files the `files` list names: nothing more, nothing less;
- runs `bin/cellucid.mjs` and imports `index.mjs`.

It then runs `npm publish --access public` in `npm/`. npm generates
[provenance](https://docs.npmjs.com/generating-provenance-statements)
attestations itself for a trusted publish from GitHub Actions, so the command
carries no `--provenance` flag.

---

## Re-running and failures

- **A failed run** (a runner or network failure, the trusted publisher not
  set up yet): open the run under **Actions** and click **Re-run jobs**. It
  publishes the same release again.
- **A check refused the release** (wrong tag, commit not on `main`, stray
  file): delete the GitHub Release and its tag, fix `main`, and publish the
  release again.
- **npm already has this version** (`E403 ... cannot publish over the
  previously published versions`): the publish succeeded earlier; nothing to
  do. A version number is taken forever, even if unpublished; a changed
  package needs a new version.
- **`ENEEDAUTH` ("Unable to authenticate") on publish**: the trusted
  publisher on npmjs.com does not match this repository and workflow exactly
  (see the table above), or its 2-day window expired before the first
  publish. Fix it on npmjs.com, then re-run the run's jobs.

npm's [unpublish policy](https://docs.npmjs.com/policies/unpublish): within
72 hours a version can be removed with `npm unpublish cellucid@X.Y.Z`; after
that, `npm deprecate cellucid@X.Y.Z "message"` warns installers instead.

---

## Reference

### Package naming across ecosystems

| Context | Name |
|---------|------|
| npm | `cellucid` |
| PyPI | `cellucid` |
| R / CRAN | `cellucid` |
| conda-forge (R build) | `r-cellucid` |
| GitHub repo (web app) | `theislab/cellucid` |

### Useful links

| Resource | URL |
|----------|-----|
| The package | https://www.npmjs.com/package/cellucid |
| Trusted publishers | https://docs.npmjs.com/trusted-publishers |
| Provenance | https://docs.npmjs.com/generating-provenance-statements |
| Unpublish policy | https://docs.npmjs.com/policies/unpublish |
| Name disputes | https://docs.npmjs.com/policies/disputes |
| `package.json` reference | https://docs.npmjs.com/cli/configuring-npm/package-json |

### Related guides in this project

| Ecosystem | Guide |
|-----------|-------|
| Python / PyPI | [`scripts/publishing/PUBLISHING.md` in `theislab/cellucid-python`](https://github.com/theislab/cellucid-python/blob/main/scripts/publishing/PUBLISHING.md) |
| R / CRAN | [`publishing.md` in `theislab/cellucid-r`](https://github.com/theislab/cellucid-r/blob/main/publishing.md) |
