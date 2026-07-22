# Releasing

The public source lives in this repository. Local deployment state and private
compatibility overrides must remain in a separate directory and must never be
copied into Git.

1. Start from a clean `main` branch.
2. Run `npm ci --include=dev` and `npm run release:check`.
3. Review `git diff --cached` and `git ls-files` for private data.
4. Run `npm run release:dry -- patch`.
5. Push `main`, then start the `Release` GitHub Actions workflow.

`release:check` scans source privacy, runs protocol and security tests, builds
the production client, packs and installs the package in a clean temporary
home, starts that installed server to verify runtime path isolation, and audits
the dependency tree that consumers actually receive.

Tags use semantic versioning (`vMAJOR.MINOR.PATCH`). Git tags and GitHub releases
are the immutable version archive; do not maintain mutable copied source trees
for each version. Release tarballs can be downloaded from GitHub when an offline
archive is required.
