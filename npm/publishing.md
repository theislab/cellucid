# Publishing `cellucid` (npm)

A step-by-step guide for publishing this package to [npmjs.com](https://www.npmjs.com),
written for someone who has **never published to npm before**. Every command is
shown in full, with the output you should expect.

Total time for the first publish: **about 20 minutes**, most of it account setup.

---

## Table of Contents

1. [What you are publishing, and why](#what-you-are-publishing-and-why)
2. [Before you start](#before-you-start)
3. [One-time account setup](#one-time-account-setup)
4. [Publishing, step by step](#publishing-step-by-step)
5. [After publishing](#after-publishing)
6. [Publishing a new version later](#publishing-a-new-version-later)
7. [Optional: the `@theislab` scope](#optional-the-theislab-scope)
8. [Troubleshooting](#troubleshooting)
9. [Reference](#reference)

---

## What you are publishing, and why

This directory is **not** the Cellucid web app. It is a small placeholder
package whose only job is to claim the name `cellucid` on npm before someone
else does.

| | |
|---|---|
| Package name | `cellucid` |
| Version | `0.0.1` |
| Contents | `package.json`, `README.md`, `LICENSE`, `index.mjs`, `bin/cellucid.mjs` |
| Size | A few kilobytes |
| What it does | `npx cellucid` prints where the real app and docs live |

**Why not publish the actual app?** The web app is ~17 MB of static files with
no importable entry point — nothing an npm user could `import` or call. The
name is worth holding anyway, for one concrete future use: a `npx cellucid`
command that serves the app on `localhost` for users behind firewalls that
block `www.cellucid.com`.

**Is reserving a name allowed?** Yes, when the name matches a real project you
actually ship — which is the case here (`cellucid` on PyPI, `cellucid` for R,
`www.cellucid.com`, `github.com/theislab/cellucid`). npm does have a
[dispute policy](https://docs.npmjs.com/policies/disputes) for names held by
people with no claim to them; your claim is strong and documented in the README,
so this is name reservation, not squatting. Keep the README honest about the
package being a placeholder — that is what makes the difference.

---

## Before you start

### 1. Check you have Node and npm

```bash
node -v
npm -v
```

Expected: `v20.x` or higher, and npm `10.x` or higher.

If either command says "command not found", install Node from
[nodejs.org](https://nodejs.org) (the LTS version) and reopen your terminal.

### 2. Go to the right directory

**This matters.** The repository root has its own `package.json` marked
`"private": true` for running tests — publishing from there would fail, and
publishing the whole repo is not what you want.

```bash
cd /Users/kemalinecik/git_nosync/master_cellucid/cellucid/npm
```

Confirm you are in the right place — this must print `cellucid`:

```bash
node -p "require('./package.json').name"
```

### 3. Confirm the name is still free

```bash
npm view cellucid
```

Expected output — this error is the **good** outcome:

```
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/cellucid - Not found
```

If instead you see package details, someone has taken the name. Stop and see
[Troubleshooting](#name-is-already-taken).

---

## One-time account setup

Do this once. Skip to [Publishing](#publishing-step-by-step) if you already have
a verified npm account.

### Step 1 — Create the account

1. Go to **https://www.npmjs.com/signup**
2. Pick a username (public, permanent — it appears on every package you publish)
3. Use an email you will keep long-term
4. Choose the **Free** plan (public packages are free; you do not need a paid plan)

### Step 2 — Verify your email

**You cannot publish until you do this.** npm sends a verification link within a
minute or two. Click it. If it does not arrive, check spam, then use
"Resend verification email" in your npm account settings.

### Step 3 — Turn on two-factor authentication

npm requires 2FA for publishing. Set it up now rather than hitting a wall later.

1. Go to **https://www.npmjs.com/settings/~/profile** (replace `~` happens automatically once logged in)
2. Find **Two-Factor Authentication** → **Enable 2FA**
3. Choose **Authorization and Publishing** (the stricter option — asks for a code when you publish)
4. Scan the QR code with an authenticator app (1Password, Authy, Google Authenticator, iOS Passwords)
5. **Save the recovery codes somewhere safe.** If you lose your phone without
   them, recovering the account means emailing npm support.

### Step 4 — Log in from the terminal

```bash
npm login
```

npm prints a URL and waits. Open it in your browser, confirm, and return to the
terminal — it will say `Logged in on https://registry.npmjs.org/`.

Verify:

```bash
npm whoami
```

This should print your npm username. If it errors, the login did not complete —
run `npm login` again.

---

## Publishing, step by step

### Step 1 — See exactly what will be uploaded

Never publish without looking at this first.

```bash
npm publish --dry-run
```

`--dry-run` does everything except actually upload. Read the file list in the
output. You should see **exactly five files**:

```
npm notice 📦  cellucid@0.0.1
npm notice === Tarball Contents ===
npm notice 1.5kB LICENSE
npm notice 2.4kB README.md
npm notice 1.0kB bin/cellucid.mjs
npm notice 1.1kB index.mjs
npm notice 1.0kB package.json
npm notice === Tarball Details ===
npm notice name:          cellucid
npm notice version:       0.0.1
npm notice total files:   5
```

**Stop and investigate if you see anything else** — especially `node_modules`,
`tests/`, `assets/`, or `.env` files. The `"files"` field in `package.json`
controls this; nothing outside that list should appear.

### Step 2 — Test the CLI locally

Confirm the placeholder actually runs before strangers can run it:

```bash
node bin/cellucid.mjs
```

You should see the "This npm package is a name reservation" message.

### Step 3 — Publish

```bash
npm publish
```

If 2FA is set to "Authorization and Publishing", you will be prompted:

```
This operation requires a one-time password.
Enter OTP:
```

Type the 6-digit code from your authenticator app and press Enter.

Success looks like:

```
+ cellucid@0.0.1
```

> The package is already configured with `"publishConfig": { "access": "public" }`,
> so you do not need to pass `--access public`. Adding it does no harm.

### Step 4 — Verify it worked

Wait about a minute for the registry to propagate, then:

```bash
npm view cellucid
```

And try it the way a stranger would — from a directory that is **not** this one:

```bash
cd ~ && npx cellucid@latest
```

Then open **https://www.npmjs.com/package/cellucid** in a browser and check that
the README renders and the "Repository" and "Homepage" links point where they
should.

### Step 5 — Commit the package to git

The publish and your repository are separate things; publishing does not commit
anything.

```bash
cd /Users/kemalinecik/git_nosync/master_cellucid/cellucid
git add npm
git commit -m "Add npm name-reservation package for cellucid"
```

---

## After publishing

### You cannot simply undo it

npm's [unpublish policy](https://docs.npmjs.com/policies/unpublish):

- **Within 72 hours** of publishing, you can remove a version:
  `npm unpublish cellucid@0.0.1`
- **After 72 hours**, you generally cannot. The correct move is
  `npm deprecate cellucid@0.0.1 "message"`, which leaves the package installable
  but warns anyone who installs it.
- **Never republish the same version number.** Once `0.0.1` is taken, it is
  taken forever, even if unpublished. Bump to `0.0.2`.

This is why the dry run in Step 1 matters — a leaked file cannot be recalled.

### Add a second owner

If you are hit by a bus, or just change email addresses, a single-owner package
is a liability. Add a co-maintainer once they have an npm account:

```bash
npm owner add <their-npm-username> cellucid
npm owner ls cellucid
```

### Keeping the claim credible

A placeholder that sits untouched for years is the profile most likely to draw a
name dispute. Two cheap defenses:

- The README states plainly what the package is and links to the live project —
  already done.
- Publish a patch version occasionally (a README touch-up is enough) so the
  package does not look abandoned.

---

## Publishing a new version later

When the real CLI ships, or you just fix a typo:

### Step 1 — Make your changes

Edit files in this directory.

### Step 2 — Bump the version

Do not hand-edit the version in `package.json` — let npm do it, so it cannot
drift:

```bash
npm version patch     # 0.0.1 → 0.0.2   (fixes, README edits)
npm version minor     # 0.0.2 → 0.1.0   (new functionality, backwards-compatible)
npm version major     # 0.1.0 → 1.0.0   (breaking changes)
```

This rewrites `package.json` and creates a git commit and tag.

> **Note on version numbers:** this package starts at `0.0.1` deliberately,
> independent of the Python package's version (`0.9.1` at time of writing). A
> placeholder should not imply feature parity with the real distributions. When
> a functional CLI ships, jumping straight to a matching version (e.g.
> `npm version 0.10.0`) is fine — npm only requires versions to increase.

### Step 3 — Dry run, then publish

```bash
npm publish --dry-run
npm publish
```

### Step 4 — Push the git tag

```bash
git push && git push --tags
```

---

## Optional: the `@theislab` scope

Alongside the unscoped `cellucid` name, you can publish under an organization
scope — `@theislab/cellucid`. This is worth doing if you expect several related
JS packages later, since a scope groups them and prevents individual name races.

1. Create the org at **https://www.npmjs.com/org/create** — name it `theislab`,
   choose the **free** plan (free orgs can publish unlimited *public* packages)
2. Copy this directory, change `"name"` to `"@theislab/cellucid"`
3. Publish with `npm publish --access public`

**Scoped packages default to private**, which fails on a free plan with an
`E402` error — hence the explicit `--access public`.

This is genuinely optional. The unscoped `cellucid` is the name that matters,
because it is the one that matches PyPI and CRAN.

---

## Troubleshooting

| Error | What it means | Fix |
|-------|---------------|-----|
| `ENEEDAUTH` | Not logged in | `npm login`, then `npm whoami` to confirm |
| `E403 Forbidden` | Email not verified, or name taken | Verify your email via the link npm sent; then re-check `npm view cellucid` |
| `E403 ... you do not have permission` | Someone else owns the name | See [name is already taken](#name-is-already-taken) |
| `E402 Payment Required` | Publishing a scoped package as private | Add `--access public` |
| `EOTP` | 2FA code required | Re-run with the code: `npm publish --otp=123456` |
| `E409 Conflict` | That version already exists | Bump the version — `npm version patch` |
| `npm ERR! private` | You are in the repo root, not `npm/` | `cd` into `cellucid/npm` first |
| `EPUBLISHCONFLICT` | Version was published before, even if unpublished | Bump the version; that number is permanently burned |

### Name is already taken

If `npm view cellucid` returns real package data owned by someone else:

1. Check whether it is genuinely in use or an abandoned placeholder —
   look at the publish date, weekly downloads, and repository link
2. If it is unused and you have a legitimate claim to the name (PyPI package,
   CRAN package, live domain, GitHub project — you have all four), you can file
   a dispute: **https://docs.npmjs.com/policies/disputes**
3. In the meantime, publish under `@theislab/cellucid` — see
   [the scope section](#optional-the-theislab-scope)

### The README on npmjs.com is out of date

npm caches the rendered README from the last published version. Editing the file
locally, or on GitHub, changes nothing on npm. Publish a new patch version.

### `npx cellucid` runs an old version

npx caches downloads. Force the latest:

```bash
npx cellucid@latest
```

---

## Reference

### Package naming across ecosystems

| Context | Name |
|---------|------|
| npm | `cellucid` |
| npm (scoped alternative) | `@theislab/cellucid` |
| PyPI | `cellucid` |
| R / CRAN | `cellucid` |
| conda-forge (R build) | `r-cellucid` |
| GitHub repo (web app) | `theislab/cellucid` |

### Commands you will actually use

| Command | Purpose |
|---------|---------|
| `npm whoami` | Check who you are logged in as |
| `npm view cellucid` | Inspect the published package |
| `npm publish --dry-run` | See the file list without uploading |
| `npm publish` | Upload |
| `npm version patch` | Bump version, commit, tag |
| `npm owner ls cellucid` | List maintainers |
| `npm deprecate cellucid@x.y.z "msg"` | Warn users off a bad version |

### Useful links

| Resource | URL |
|----------|-----|
| Sign up | https://www.npmjs.com/signup |
| Your packages | https://www.npmjs.com/settings/~/packages |
| Access tokens (for CI) | https://www.npmjs.com/settings/~/tokens |
| Create an org | https://www.npmjs.com/org/create |
| Unpublish policy | https://docs.npmjs.com/policies/unpublish |
| Name disputes | https://docs.npmjs.com/policies/disputes |
| `package.json` reference | https://docs.npmjs.com/cli/configuring-npm/package-json |

### Related guides in this project

| Ecosystem | Guide |
|-----------|-------|
| R / CRAN | [`publishing.md` in `theislab/cellucid-r`](https://github.com/theislab/cellucid-r/blob/main/publishing.md) |
