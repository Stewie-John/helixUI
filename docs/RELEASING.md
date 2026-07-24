# Releasing

The public source lives in this repository. Local deployment state and private
compatibility overrides must remain in a separate directory and must never be
copied into Git.

HelixUI uses the independent `YYYY.M.PATCH` calendar-version scheme documented
in [VERSIONING.md](VERSIONING.md).

1. Start from a clean `main` branch using Node.js 22 or newer.
2. Run `npm ci --include=dev` and `npm run release:check`.
3. Review `git diff --cached` and `git ls-files` for private data.
4. Update the `Unreleased` changelog and run
   `npm run release:dry -- YYYY.M.PATCH`.
5. Push the reviewed source commit to `main`.
6. Add an npm automation token as the `NPM_TOKEN` GitHub Actions secret. It
   must be allowed to publish `@stewiejohn/helix-ui`.
7. Start the `Release` workflow and enter the exact calendar version. The
   workflow validates npm authentication, repeats all release checks, creates
   the Git tag and GitHub Release, and publishes the npm package with
   provenance.

`release:check` scans source privacy, runs protocol and security tests, builds
the production client, packs and installs the package in a clean temporary
home, starts that installed server to verify runtime path isolation, and audits
the dependency tree that consumers actually receive.

The local public worktree uses `https://github.com/StewartJohn0/helixui.git` as
`origin`. Change that remote before publishing a fork under another account.

Tags use `vYYYY.M.PATCH`. Git tags and GitHub releases are the immutable version
archive; do not maintain mutable copied source trees for each version. Release
tarballs can be downloaded from GitHub when an offline archive is required.

After the first calendar-versioned release succeeds, deprecate the inherited
npm version with:

```bash
npm deprecate @stewiejohn/helix-ui@1.23.0 \
  "Legacy inherited version line; upgrade to 2026.7.0 or newer."
```
