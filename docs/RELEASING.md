# Releasing

The public source lives in this repository. Local deployment state and private
compatibility overrides must remain in a separate directory and must never be
copied into Git.

1. Start from a clean `main` branch.
2. Run `npm ci --include=dev` and `npm run verify`.
3. Review `git diff --cached` and `git ls-files` for private data.
4. Run `npm run release:dry -- patch`.
5. Push `main`, then start the `Release` GitHub Actions workflow.

Tags use semantic versioning (`vMAJOR.MINOR.PATCH`). Git tags and GitHub releases
are the immutable version archive; do not maintain mutable copied source trees
for each version. Release tarballs can be downloaded from GitHub when an offline
archive is required.
